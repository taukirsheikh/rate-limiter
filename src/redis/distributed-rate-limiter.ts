import { TypedEventEmitter } from '../event-emitter.js';
import { PriorityQueue } from '../priority-queue.js';
import { RedisStorage, type RedisConnectionOptions } from './redis-storage.js';
import type {
  Job,
  JobOptions,
  LimiterState,
  RateLimiterOptions,
  Stats,
} from '../types.js';

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a timeout promise
 */
function createTimeout(ms: number, jobId: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Job "${jobId}" timed out after ${ms}ms`));
    }, ms);
  });
}

/**
 * Options for the distributed rate limiter
 */
export interface DistributedRateLimiterOptions extends RateLimiterOptions {
  /** Redis connection options */
  redis: RedisConnectionOptions;

  /**
   * How often to poll Redis for slot availability (ms)
   * @default 50
   */
  pollInterval?: number;

  /**
   * Heartbeat interval to keep state alive (ms)
   * @default 30000
   */
  heartbeatInterval?: number;

  /**
   * Jobs running longer than this (ms) are presumed dead — their process
   * crashed without releasing the slot — and are reaped on the next
   * heartbeat, reclaiming running/currentWeight. Must exceed your longest
   * expected job duration.
   * @default 60000
   */
  staleJobTimeout?: number;

  /**
   * Whether to clear state on start (for testing)
   * @default false
   */
  clearOnStart?: boolean;

  /**
   * How long to wait for Redis when calling `ready()` (milliseconds).
   * Use a number (e.g. `60000`) to fail after that many ms, or `Infinity` / `null` to wait until
   * Redis connects.
   * @default Infinity
   */
  readyTimeout?: number | null;
}

/**
 * DistributedRateLimiter - A Redis-backed rate limiter for distributed systems.
 *
 * This limiter coordinates across multiple servers/processes using Redis
 * for shared state. All rate limiting decisions are made atomically via
 * Lua scripts.
 *
 * @example
 * ```ts
 * const limiter = new DistributedRateLimiter({
 *   maxConcurrent: 10,
 *   minTime: 100,
 *   redis: {
 *     host: 'localhost',
 *     port: 6379,
 *     keyPrefix: 'myapp:ratelimit',
 *   },
 * });
 *
 * await limiter.ready();
 *
 * const result = await limiter.schedule(async () => {
 *   return await fetch('https://api.example.com/data');
 * });
 * ```
 */
export class DistributedRateLimiter extends TypedEventEmitter {
  readonly id: string;

  // Configuration
  private readonly maxConcurrent: number;
  private readonly minTime: number;
  private readonly maxPerInterval: number;
  private readonly interval: number;
  private readonly defaultTimeout: number | null;
  private readonly defaultRetryCount: number;
  private readonly defaultRetryDelay: number | ((attempt: number, error: Error) => number);
  private readonly pollInterval: number;
  private readonly heartbeatInterval: number;
  private readonly staleJobTimeout: number;

  // Reservoir (refresh happens lazily inside the ACQUIRE_SLOT Lua script)
  private readonly initialReservoir: number | null;
  private readonly reservoirRefreshInterval: number;
  private readonly reservoirRefreshAmount: number;

  // Redis storage
  private readonly storage: RedisStorage;
  private readonly readyTimeout: number | null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private initPromise: Promise<void> | null = null;

  // Local queue for pending jobs
  private readonly localQueue = new PriorityQueue();
  private processing = false;
  private paused = false;
  private stopped = false;

  // Local stats (in addition to Redis stats)
  private localDone = 0;
  private localFailed = 0;
  private totalWaitTime = 0;
  private totalExecutionTime = 0;

  constructor(options: DistributedRateLimiterOptions) {
    super();

    this.id = options.id ?? generateId();
    this.maxConcurrent = options.maxConcurrent ?? Infinity;
    this.minTime = options.minTime ?? 0;
    this.maxPerInterval = options.maxPerInterval ?? Infinity;
    this.interval = options.interval ?? 1000;
    this.defaultTimeout = options.timeout ?? null;
    this.defaultRetryCount = options.retryCount ?? 0;
    this.defaultRetryDelay = options.retryDelay ?? 0;
    this.pollInterval = options.pollInterval ?? 50;
    this.heartbeatInterval = options.heartbeatInterval ?? 30000;
    this.staleJobTimeout = options.staleJobTimeout ?? 60000;

    // Reservoir (0 interval = lazy refresh disabled)
    this.initialReservoir = options.reservoir ?? null;
    this.reservoirRefreshInterval =
      this.initialReservoir !== null ? (options.reservoirRefreshInterval ?? 0) : 0;
    this.reservoirRefreshAmount = options.reservoirRefreshAmount ?? (options.reservoir ?? 0);

    // Create Redis storage
    this.storage = new RedisStorage(options.redis);
    this.readyTimeout = options.readyTimeout !== undefined ? options.readyTimeout : Infinity;

    // Auto-initialize
    this.initPromise = this.initialize(options.clearOnStart ?? false);
  }

  /**
   * Initialize the distributed limiter
   */
  private async initialize(clearOnStart: boolean): Promise<void> {
    await this.storage.waitForConnection(this.readyTimeout);

    if (clearOnStart) {
      await this.storage.clear(this.id);
    }

    await this.storage.initialize(this.id, this.initialReservoir);

    // Start heartbeat (extends TTLs and reaps stale jobs from dead processes)
    this.heartbeatTimer = setInterval(async () => {
      try {
        const reaped = await this.storage.heartbeat(this.id, this.staleJobTimeout);
        if (reaped > 0) {
          this.emit('reaped', reaped);
          this.tryProcess();
        }
      } catch (error) {
        this.emit('error', error as Error);
      }
    }, this.heartbeatInterval);
  }

  /**
   * Wait for the limiter to be ready
   */
  async ready(): Promise<this> {
    await this.initPromise;
    return this;
  }

  /**
   * Schedule a job for execution
   */
  schedule<T>(fn: () => Promise<T>): Promise<T>;
  schedule<T>(options: JobOptions, fn: () => Promise<T>): Promise<T>;
  schedule<T>(
    optionsOrFn: JobOptions | (() => Promise<T>),
    maybeFn?: () => Promise<T>
  ): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error('Limiter has been stopped'));
    }

    const options: JobOptions = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;

    const resolvedPriority =
      typeof options.priority === 'function' ? options.priority() : (options.priority ?? 5);

    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        id: options.id ?? generateId(),
        priority: resolvedPriority,
        weight: options.weight ?? 1,
        timeout: options.timeout !== undefined ? options.timeout : this.defaultTimeout,
        retryCount: options.retryCount ?? this.defaultRetryCount,
        retryAttempt: 0,
        fn,
        resolve,
        reject,
        signal: options.signal,
        queuedAt: Date.now(),
      };

      // Check abort signal
      if (job.signal?.aborted) {
        reject(new Error('Job was aborted'));
        return;
      }

      // Handle abort signal
      if (job.signal) {
        job.signal.addEventListener(
          'abort',
          () => {
            if (this.localQueue.has(job.id)) {
              this.localQueue.removeById(job.id);
              reject(new Error('Job was aborted'));
            }
          },
          { once: true }
        );
      }

      // Add to local queue
      const position = this.localQueue.enqueue(job as Job);
      this.emit('queued', { job: job as Job, position });

      // Start processing
      this.tryProcess();
    });
  }

  /**
   * Wrap a function to be rate-limited
   */
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options?: JobOptions
  ): (...args: TArgs) => Promise<TResult> {
    return (...args: TArgs) => {
      return this.schedule(options ?? {}, () => fn(...args));
    };
  }

  /**
   * Try to process jobs from the local queue
   */
  private async tryProcess(): Promise<void> {
    if (this.processing || this.paused || this.stopped) return;
    if (this.localQueue.isEmpty) return;

    // Claim the guard synchronously — setting it after an await lets two
    // callers race into the loop, double-executing one job and dropping another
    this.processing = true;

    try {
      // Ensure initialized
      await this.initPromise;

      while (!this.localQueue.isEmpty && !this.paused && !this.stopped) {
        const job = this.localQueue.peek();
        if (!job) break;

        // Try to acquire a slot from Redis
        const result = await this.storage.acquireSlot(this.id, {
          maxConcurrent: this.maxConcurrent,
          minTime: this.minTime,
          maxPerInterval: this.maxPerInterval,
          interval: this.interval,
          weight: job.weight,
          jobId: job.id,
          reservoirRefreshInterval: this.reservoirRefreshInterval,
          reservoirRefreshAmount: this.reservoirRefreshAmount,
        });

        if (result.allowed) {
          // The heap root may have changed during the acquire round-trip (a
          // higher-priority schedule(), cancel(), or an abort signal firing)
          // — remove the exact job we acquired a slot for, never dequeue()
          // the possibly-different current root
          const removed = this.localQueue.removeById(job.id);
          if (!removed) {
            // The peeked job vanished (cancelled/aborted) while we were
            // acquiring: give the slot back and keep processing
            await this.storage
              .releaseSlot(this.id, job.id, job.weight, false)
              .catch((e) =>
                this.emit('error', e instanceof Error ? e : new Error(String(e)))
              );
            continue;
          }
          this.executeJob(job);
        } else {
          // Wait and retry
          if (result.reason === 'reservoir') {
            this.emit('depleted', undefined);
          }

          const waitTime = Math.max(result.waitTime, this.pollInterval);
          await sleep(waitTime);
        }
      }
    } catch (error) {
      // tryProcess is fire-and-forget from schedule()/executeJob()/heartbeat/
      // resume() — a rejection escaping here would be an unhandled promise
      // rejection (fatal by default in Node >= 15) and would strand every
      // queued job. Surface the error and keep polling instead.
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      if (!this.stopped) {
        setTimeout(() => this.tryProcess(), this.pollInterval);
      }
    } finally {
      this.processing = false;
    }

    // Check if idle (skip when stopped — the connection may already be
    // closed; tryProcess is fire-and-forget so a rejection here is unhandled)
    if (this.localQueue.isEmpty && !this.stopped) {
      try {
        const state = await this.storage.getState(this.id);
        if (state.running === 0) {
          this.emit('idle', undefined);
        }
      } catch (error) {
        this.emit('error', error as Error);
      }
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(job: Job): Promise<void> {
    job.startedAt = Date.now();

    this.emit('executing', {
      job,
      queued: this.localQueue.size,
      running: -1, // Unknown locally, would need to query Redis
    });

    const waitTime = job.startedAt - job.queuedAt;
    const startTime = Date.now();

    // Step 1: run the job function; capture the outcome without releasing yet
    let result: unknown;
    let fnError: Error | null = null;
    try {
      // Check if aborted
      if (job.signal?.aborted) {
        throw new Error('Job was aborted');
      }

      // Execute with optional timeout
      if (job.timeout !== null) {
        result = await Promise.race([job.fn(), createTimeout(job.timeout, job.id)]);
      } else {
        result = await job.fn();
      }
    } catch (error) {
      fnError = error instanceof Error ? error : new Error(String(error));
    }

    // Step 2: release the slot (best-effort; a release failure must never
    // retry or reject a job whose fn already succeeded)
    try {
      await this.storage.releaseSlot(this.id, job.id, job.weight, fnError === null);
    } catch (releaseErr) {
      this.emit('error', releaseErr instanceof Error ? releaseErr : new Error(String(releaseErr)));
    }

    // Step 3: settle the job
    if (fnError === null) {
      const duration = Date.now() - startTime;

      // Update local stats
      this.totalWaitTime += waitTime;
      this.totalExecutionTime += duration;
      this.localDone++;

      this.emit('done', { job, result, duration });
      job.resolve(result);
    } else {
      const err = fnError;

      // Check for retry
      if (job.retryAttempt < job.retryCount) {
        job.retryAttempt++;
        this.emit('retry', { job, attempt: job.retryAttempt, error: err });

        // Calculate retry delay
        let delay: number;
        if (typeof this.defaultRetryDelay === 'function') {
          delay = this.defaultRetryDelay(job.retryAttempt, err);
        } else {
          delay = this.defaultRetryDelay;
        }

        // Re-queue after delay
        setTimeout(() => {
          job.queuedAt = Date.now();
          this.localQueue.enqueue(job);
          this.tryProcess();
        }, delay);

        this.emit('failed', { job, error: err, willRetry: true });
      } else {
        this.localFailed++;
        this.emit('failed', { job, error: err, willRetry: false });
        this.emit('error', err);
        job.reject(err);
      }
    }

    // Continue processing
    this.tryProcess();
  }

  /**
   * Pause processing
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume processing
   */
  resume(): void {
    this.paused = false;
    this.tryProcess();
  }

  /**
   * Stop the limiter
   */
  async stop(): Promise<void> {
    this.stopped = true;

    // Clear timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Reject all local queued jobs
    const error = new Error('Limiter was stopped');
    while (!this.localQueue.isEmpty) {
      const job = this.localQueue.dequeue()!;
      job.reject(error);
    }

    // Close Redis connection
    await this.storage.close();
  }

  /**
   * Wait for all jobs to complete (local queue empty and no jobs running in Redis).
   */
  async waitForIdle(): Promise<void> {
    await this.initPromise;
    while (true) {
      const state = await this.storage.getState(this.id);
      if (this.localQueue.isEmpty && state.running === 0) {
        return;
      }
      await sleep(this.pollInterval);
    }
  }

  /**
   * Get current state (from Redis)
   */
  async getState(): Promise<LimiterState> {
    await this.initPromise;
    const state = await this.storage.getState(this.id);

    return {
      running: state.running,
      queued: this.localQueue.size,
      done: state.done,
      failed: state.failed,
      reservoir: state.reservoir,
    };
  }

  /**
   * Get detailed statistics
   */
  async getStats(): Promise<Stats> {
    const state = await this.getState();

    return {
      ...state,
      avgWaitTime: this.localDone > 0 ? this.totalWaitTime / this.localDone : 0,
      avgExecutionTime: this.localDone > 0 ? this.totalExecutionTime / this.localDone : 0,
    };
  }

  /**
   * Check if idle (local queue empty; does not check Redis running count).
   */
  isIdle(): boolean {
    return this.localQueue.isEmpty;
  }

  /**
   * Get queued jobs (local queue snapshot).
   */
  getQueued(): readonly Job[] {
    return this.localQueue.toArray();
  }

  /**
   * Update reservoir value
   */
  async updateReservoir(value: number): Promise<void> {
    await this.initPromise;
    await this.storage.updateReservoir(this.id, value);
    this.tryProcess();
  }

  /**
   * Increment reservoir
   */
  async incrementReservoir(amount: number): Promise<void> {
    await this.initPromise;
    await this.storage.incrementReservoir(this.id, amount);
    this.tryProcess();
  }

  /**
   * Cancel a job by ID
   */
  cancel(jobId: string): boolean {
    const job = this.localQueue.removeById(jobId);
    if (job) {
      job.reject(new Error('Job was cancelled'));
      return true;
    }
    return false;
  }

  /**
   * Clear all state in Redis
   */
  async clear(): Promise<void> {
    await this.initPromise;
    await this.storage.clear(this.id);
  }

  /**
   * Get the Redis storage instance
   */
  getStorage(): RedisStorage {
    return this.storage;
  }
}

