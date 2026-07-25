/**
 * Tests for DistributedRateLimiter
 *
 * These tests require a running Redis instance at localhost:6379
 * Skip these tests if Redis is not available.
 */

import { DistributedRateLimiter, Priority } from '../index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Test runner
let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    if ((error as Error).message === 'SKIP') {
      console.log(`  ⊘ ${name} (skipped)`);
      skipped++;
    } else {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }
}

function skip(reason?: string) {
  const err = new Error('SKIP');
  (err as any).reason = reason;
  throw err;
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${expected}, got ${actual}`);
  }
}

// Check Redis availability
async function isRedisAvailable(): Promise<boolean> {
  try {
    const limiter = new DistributedRateLimiter({
      id: 'test-check',
      redis: { host: 'localhost', port: 6379 },
    });
    await limiter.ready();
    await limiter.stop();
    return true;
  } catch {
    return false;
  }
}

// Create limiter helper
function createLimiter(
  options: Partial<Parameters<typeof DistributedRateLimiter>[0]> = {}
) {
  return new DistributedRateLimiter({
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'test:ratelimit',
    },
    clearOnStart: true,
    ...options,
  } as any);
}

// Tests
async function testConnection() {
  console.log('\n🔌 Connection Tests');

  await test('connects to Redis', async () => {
    const limiter = createLimiter();
    await limiter.ready();
    assert(limiter.getStorage().isConnected(), 'Should be connected');
    await limiter.stop();
  });

  await test('handles connection errors gracefully', async () => {
    try {
      const limiter = new DistributedRateLimiter({
        id: 'bad-connection',
        redis: {
          host: 'invalid-host',
          port: 9999,
          redisOptions: {
            connectTimeout: 500,
            maxRetriesPerRequest: 0,
          },
        },
      });
      await limiter.ready();
      throw new Error('Should have failed');
    } catch (error) {
      assert(error instanceof Error, 'Should throw error');
    }
  });
}

async function testConcurrency() {
  console.log('\n🔀 Distributed Concurrency Tests');

  await test('respects maxConcurrent across instances', async () => {
    const sharedId = `shared-${Date.now()}`;

    // Create two instances with same ID
    const limiter1 = createLimiter({ id: sharedId, maxConcurrent: 2 });
    const limiter2 = createLimiter({ id: sharedId, maxConcurrent: 2, clearOnStart: false });

    await Promise.all([limiter1.ready(), limiter2.ready()]);

    let concurrent = 0;
    let maxConcurrent = 0;

    const job = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(100);
      concurrent--;
    };

    // Schedule 2 jobs on each instance
    const promises = [
      limiter1.schedule(job),
      limiter1.schedule(job),
      limiter2.schedule(job),
      limiter2.schedule(job),
    ];

    await Promise.all(promises);

    assert(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <= 2`);

    await Promise.all([limiter1.stop(), limiter2.stop()]);
  });

  await test('respects job weight', async () => {
    const limiter = createLimiter({ maxConcurrent: 3 });
    await limiter.ready();

    let maxConcurrent = 0;
    let concurrent = 0;

    const createJob = (weight: number) => async () => {
      concurrent += weight;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(50);
      concurrent -= weight;
    };

    await Promise.all([
      limiter.schedule({ weight: 2 }, createJob(2)),
      limiter.schedule({ weight: 1 }, createJob(1)),
      limiter.schedule({ weight: 2 }, createJob(2)),
    ]);

    assert(maxConcurrent <= 3, `Max concurrent was ${maxConcurrent}`);

    await limiter.stop();
  });
}

async function testRateLimiting() {
  console.log('\n⏱️  Distributed Rate Limiting Tests');

  await test('respects minTime between jobs', async () => {
    const limiter = createLimiter({ minTime: 100 });
    await limiter.ready();

    const timestamps: number[] = [];

    await Promise.all(
      Array.from({ length: 3 }, () =>
        limiter.schedule(async () => {
          timestamps.push(Date.now());
        })
      )
    );

    for (let i = 1; i < timestamps.length; i++) {
      const diff = timestamps[i] - timestamps[i - 1];
      assert(diff >= 90, `Time between jobs was ${diff}ms, expected >= 100ms`);
    }

    await limiter.stop();
  });

  await test('respects maxPerInterval', async () => {
    const limiter = createLimiter({
      maxPerInterval: 2,
      interval: 200,
    });
    await limiter.ready();

    const timestamps: number[] = [];
    const start = Date.now();

    await Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.schedule(async () => {
          timestamps.push(Date.now() - start);
        })
      )
    );

    // First 2 should be fast, next 2 after interval
    assert(timestamps[0] < 100, 'First job should be immediate');
    assert(timestamps[1] < 100, 'Second job should be immediate');
    assert(timestamps[2] >= 150, `Third job at ${timestamps[2]}ms, expected after interval`);

    await limiter.stop();
  });
}

async function testReservoir() {
  console.log('\n🪣 Distributed Reservoir Tests');

  await test('limits execution by reservoir', async () => {
    const limiter = createLimiter({ reservoir: 2 });
    await limiter.ready();

    let executed = 0;
    let depleted = false;

    limiter.on('depleted', () => {
      depleted = true;
    });

    // Try to schedule 3 jobs
    const job1 = limiter.schedule(async () => {
      executed++;
      return 1;
    });
    const job2 = limiter.schedule(async () => {
      executed++;
      return 2;
    });
    const job3Promise = limiter.schedule(async () => {
      executed++;
      return 3;
    });
    // Blocked by the empty reservoir; stop() below rejects it — swallow so
    // the expected rejection doesn't crash the process
    job3Promise.catch(() => {});

    // Wait for first two
    await Promise.all([job1, job2]);

    // Third should be blocked
    await sleep(200);

    assertEqual(executed, 2, `Expected 2 executed, got ${executed}`);
    assert(depleted, 'Should have emitted depleted event');

    await limiter.stop();
  });

  await test('reservoir shared across instances', async () => {
    const sharedId = `shared-reservoir-${Date.now()}`;

    const limiter1 = createLimiter({ id: sharedId, reservoir: 2 });
    const limiter2 = createLimiter({ id: sharedId, reservoir: 2, clearOnStart: false });

    await Promise.all([limiter1.ready(), limiter2.ready()]);

    let executed = 0;

    // Each instance uses 1 token
    await limiter1.schedule(async () => {
      executed++;
    });
    await limiter2.schedule(async () => {
      executed++;
    });

    // Third should be blocked (reservoir exhausted)
    const blocked = limiter1.schedule(async () => {
      executed++;
    });
    blocked.catch(() => {}); // rejected by stop() below — expected

    await sleep(200);
    assertEqual(executed, 2, 'Only 2 jobs should execute');

    await Promise.all([limiter1.stop(), limiter2.stop()]);
  });

  await test('updateReservoir works', async () => {
    const limiter = createLimiter({ reservoir: 1 });
    await limiter.ready();

    let executed = 0;

    await limiter.schedule(async () => {
      executed++;
    });

    // Update reservoir to allow more
    await limiter.updateReservoir(2);

    await limiter.schedule(async () => {
      executed++;
    });

    assertEqual(executed, 2);

    await limiter.stop();
  });
}

async function testPriority() {
  console.log('\n⭐ Distributed Priority Tests');

  await test('executes higher priority first', async () => {
    const limiter = createLimiter({ maxConcurrent: 1 });
    await limiter.ready();

    const order: string[] = [];

    // First job blocks; wait until it is actually running before queueing
    // the others, so they contend on priority rather than racing the start
    let firstStarted!: () => void;
    const firstStartedP = new Promise<void>((r) => (firstStarted = r));
    const first = limiter.schedule({ id: 'first' }, async () => {
      firstStarted();
      await sleep(50);
      order.push('first');
    });
    await firstStartedP;

    // Queue with priorities
    const low = limiter.schedule({ id: 'low', priority: Priority.LOW }, async () => {
      order.push('low');
    });
    const high = limiter.schedule({ id: 'high', priority: Priority.HIGH }, async () => {
      order.push('high');
    });
    const critical = limiter.schedule(
      { id: 'critical', priority: Priority.CRITICAL },
      async () => {
        order.push('critical');
      }
    );

    await Promise.all([first, low, high, critical]);

    assertEqual(order[0], 'first');
    assertEqual(order[1], 'critical');
    assertEqual(order[2], 'high');
    assertEqual(order[3], 'low');

    await limiter.stop();
  });
}

async function testState() {
  console.log('\n📊 State Tests');

  await test('tracks state correctly', async () => {
    const limiter = createLimiter({ maxConcurrent: 2 });
    await limiter.ready();

    // Run some jobs
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.schedule(async () => {
          await sleep(10);
        })
      )
    );

    const state = await limiter.getState();
    assertEqual(state.done, 5, `Expected done=5, got ${state.done}`);
    assertEqual(state.running, 0, `Expected running=0, got ${state.running}`);

    await limiter.stop();
  });

  await test('tracks failures', async () => {
    const limiter = createLimiter();
    await limiter.ready();

    try {
      await limiter.schedule(async () => {
        throw new Error('Test error');
      });
    } catch {
      // Expected
    }

    const state = await limiter.getState();
    assertEqual(state.failed, 1, `Expected failed=1, got ${state.failed}`);

    await limiter.stop();
  });

  await test('state persists across instances', async () => {
    const sharedId = `persistent-${Date.now()}`;

    // First instance
    const limiter1 = createLimiter({ id: sharedId });
    await limiter1.ready();
    await limiter1.schedule(async () => 'done');
    const state1 = await limiter1.getState();
    await limiter1.stop();

    // Second instance sees the state
    const limiter2 = createLimiter({ id: sharedId, clearOnStart: false });
    await limiter2.ready();
    const state2 = await limiter2.getState();

    assertEqual(state2.done, state1.done, 'State should persist');

    await limiter2.stop();
  });
}

async function testCancellation() {
  console.log('\n❌ Cancellation Tests');

  await test('cancels queued jobs', async () => {
    const limiter = createLimiter({ maxConcurrent: 1 });
    await limiter.ready();

    // Block the limiter
    const blocking = limiter.schedule(async () => {
      await sleep(200);
    });

    // Queue a job
    const toCancel = limiter.schedule({ id: 'cancel-me' }, async () => {
      return 'should not run';
    });

    // Cancel it
    const cancelled = limiter.cancel('cancel-me');
    assert(cancelled, 'Should return true');

    try {
      await toCancel;
      throw new Error('Should have thrown');
    } catch (error) {
      assert(
        (error as Error).message.includes('cancelled'),
        'Should throw cancelled error'
      );
    }

    await blocking;
    await limiter.stop();
  });
}

async function testStaleJobReaping() {
  console.log('\n💀 Stale Job Reaping Tests');

  await test('reaps slots held by dead processes', async () => {
    const limiter = createLimiter({
      maxConcurrent: 2,
      heartbeatInterval: 100,
      staleJobTimeout: 250,
    });
    await limiter.ready();

    let reapedCount = 0;
    limiter.on('reaped', (count) => {
      reapedCount += count;
    });

    // Simulate a crashed process: acquire a slot directly and never release it
    const storage = limiter.getStorage();
    const result = await storage.acquireSlot(limiter.id, {
      maxConcurrent: 2,
      minTime: 0,
      maxPerInterval: 999999,
      interval: 1000,
      weight: 2,
      jobId: 'dead-job',
    });
    assert(result.allowed, 'Dead job should have acquired a slot');

    const before = await storage.getState(limiter.id);
    assertEqual(before.running, 1, `Expected running=1 before reap, got ${before.running}`);
    assertEqual(before.currentWeight, 2, `Expected currentWeight=2 before reap, got ${before.currentWeight}`);

    // Wait past staleJobTimeout plus at least one heartbeat tick
    await sleep(600);

    const after = await storage.getState(limiter.id);
    assertEqual(after.running, 0, `Expected running reclaimed to 0, got ${after.running}`);
    assertEqual(after.currentWeight, 0, `Expected currentWeight reclaimed to 0, got ${after.currentWeight}`);
    assertEqual(reapedCount, 1, `Expected reaped event with count 1, got ${reapedCount}`);

    await limiter.stop();
  });

  await test('does not reap healthy running jobs', async () => {
    const limiter = createLimiter({
      maxConcurrent: 1,
      heartbeatInterval: 50,
      staleJobTimeout: 10000,
    });
    await limiter.ready();

    let reaped = 0;
    limiter.on('reaped', (count) => {
      reaped += count;
    });

    await limiter.schedule(async () => {
      await sleep(200);
    });

    assertEqual(reaped, 0, `Healthy job was reaped ${reaped} times`);

    await limiter.stop();
  });
}

async function testLazyReservoirRefresh() {
  console.log('\n🔄 Lazy Reservoir Refresh Tests');

  await test('first acquire honors the configured initial reservoir', async () => {
    // reservoir !== reservoirRefreshAmount on purpose: with equal values the
    // init-clobber bug (lastReservoirRefresh seeded to 0 making the first
    // acquire refresh instantly) is invisible
    const limiter = createLimiter({
      reservoir: 1,
      reservoirRefreshInterval: 60000,
      reservoirRefreshAmount: 5,
    });
    await limiter.ready();

    await limiter.schedule(async () => 1);

    const state = await limiter.getState();
    // Broken behavior: first acquire lazily "refreshes" to refreshAmount(5)
    // before decrementing, leaving 4 instead of 0
    assertEqual(
      state.reservoir,
      0,
      `Expected initial reservoir(1) - 1 acquire = 0, got ${state.reservoir} (init clobbered by refreshAmount?)`
    );

    await limiter.stop();
  });

  await test('refresh grants capacity exactly once per interval across instances', async () => {
    const sharedId = `shared-refresh-${Date.now()}`;
    const opts = {
      reservoir: 2,
      reservoirRefreshInterval: 400,
      reservoirRefreshAmount: 2,
    };

    const limiter1 = createLimiter({ id: sharedId, ...opts });
    await limiter1.ready();

    // Drain the initial reservoir via instance 1
    await limiter1.schedule(async () => 1);
    await limiter1.schedule(async () => 2);

    let state = await limiter1.getState();
    assertEqual(state.reservoir, 0, `Reservoir should be drained, got ${state.reservoir}`);

    // Create instance 2 staggered from instance 1, so under per-process-timer
    // semantics its refresh clock would fire AFTER instance 1 consumes the
    // refreshed allowance below — re-granting capacity mid-interval
    await sleep(150);
    const limiter2 = createLimiter({ id: sharedId, ...opts, clearOnStart: false });
    await limiter2.ready();

    // Cross one refresh boundary, then let instance 1 consume the ENTIRE
    // refreshed allowance
    await sleep(320);
    await limiter1.schedule(async () => 3);
    await limiter1.schedule(async () => 4);

    state = await limiter1.getState();
    assertEqual(
      state.reservoir,
      0,
      `Expected refreshAmount(2) fully consumed by instance 1, got ${state.reservoir}`
    );

    // Still within the same interval: instance 2 must NOT be able to acquire.
    // Under per-process refresh (the pre-fix design) instance 2's own clock
    // refills the reservoir again here and this job executes.
    let executed = false;
    const blocked = limiter2.schedule(async () => {
      executed = true;
    });
    blocked.catch(() => {}); // rejected by stop() below — expected

    await sleep(200);

    assertEqual(
      executed as boolean,
      false,
      'Instance 2 acquired mid-interval — reservoir was refreshed more than once per interval'
    );
    state = await limiter2.getState();
    assertEqual(
      state.reservoir,
      0,
      `Expected reservoir still 0 mid-interval, got ${state.reservoir} (double refresh?)`
    );

    await Promise.all([limiter1.stop(), limiter2.stop()]);
  });
}

async function testSuccessPathReleaseFailure() {
  console.log('\n🧯 Success-Path Release Failure Tests');

  await test('release failure after success never re-executes the job', async () => {
    const limiter = createLimiter({ maxConcurrent: 2, retryCount: 3 });
    await limiter.ready();

    const storage = limiter.getStorage();
    const originalRelease = storage.releaseSlot.bind(storage);
    let releaseCalls = 0;
    (storage as any).releaseSlot = async (
      limiterId: string,
      jobId: string,
      weight: number,
      success: boolean
    ) => {
      releaseCalls++;
      if (success) {
        throw new Error('Simulated Redis failure on release');
      }
      return originalRelease(limiterId, jobId, weight, success);
    };

    let fnRuns = 0;
    let errorEvent: Error | null = null;
    limiter.on('error', (err) => {
      errorEvent = err;
    });

    const result = await limiter.schedule(async () => {
      fnRuns++;
      return 'success-result';
    });

    assertEqual(result, 'success-result', 'Job should resolve with its result');
    assertEqual(fnRuns, 1, `fn should run exactly once, ran ${fnRuns} times`);
    assertEqual(releaseCalls, 1, `releaseSlot should be called once, got ${releaseCalls}`);
    assert(errorEvent !== null, 'Should emit an error event for the release failure');
    assert(
      (errorEvent as unknown as Error).message.includes('Simulated Redis failure'),
      'Error event should carry the release failure'
    );

    await limiter.stop();
  });
}

// Main
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   DistributedRateLimiter Tests             ║');
  console.log('╚════════════════════════════════════════════╝');

  const redisAvailable = await isRedisAvailable();

  if (!redisAvailable) {
    console.log('\n⚠️  Redis not available at localhost:6379');
    console.log('   Skipping distributed tests.\n');
    console.log('   To run these tests, start Redis:');
    console.log('   docker run -d -p 6379:6379 redis:alpine\n');
    process.exit(0);
  }

  console.log('\n✓ Redis connected');

  await testConnection();
  await testConcurrency();
  await testRateLimiting();
  await testReservoir();
  await testPriority();
  await testState();
  await testCancellation();
  await testStaleJobReaping();
  await testLazyReservoirRefresh();
  await testSuccessPathReleaseFailure();

  console.log('\n════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);

