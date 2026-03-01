/**
 * Tests for RateLimiter
 */

import { RateLimiter, Priority, PriorityQueue } from '../index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Simple test runner
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error instanceof Error ? error.message : error}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${expected}, got ${actual}`);
  }
}

// Tests
async function testPriorityQueue() {
  console.log('\n📦 PriorityQueue Tests');

  await test('enqueue and dequeue in priority order', () => {
    const queue = new PriorityQueue();

    queue.enqueue({ id: 'low', priority: 9, queuedAt: 1 } as any);
    queue.enqueue({ id: 'high', priority: 1, queuedAt: 2 } as any);
    queue.enqueue({ id: 'medium', priority: 5, queuedAt: 3 } as any);

    assertEqual(queue.dequeue()?.id, 'high');
    assertEqual(queue.dequeue()?.id, 'medium');
    assertEqual(queue.dequeue()?.id, 'low');
  });

  await test('FIFO within same priority', () => {
    const queue = new PriorityQueue();

    queue.enqueue({ id: 'first', priority: 5, queuedAt: 1 } as any);
    queue.enqueue({ id: 'second', priority: 5, queuedAt: 2 } as any);
    queue.enqueue({ id: 'third', priority: 5, queuedAt: 3 } as any);

    assertEqual(queue.dequeue()?.id, 'first');
    assertEqual(queue.dequeue()?.id, 'second');
    assertEqual(queue.dequeue()?.id, 'third');
  });

  await test('removeById works correctly', () => {
    const queue = new PriorityQueue();

    queue.enqueue({ id: 'a', priority: 1, queuedAt: 1 } as any);
    queue.enqueue({ id: 'b', priority: 2, queuedAt: 2 } as any);
    queue.enqueue({ id: 'c', priority: 3, queuedAt: 3 } as any);

    const removed = queue.removeById('b');
    assertEqual(removed?.id, 'b');
    assertEqual(queue.size, 2);
    assertEqual(queue.dequeue()?.id, 'a');
    assertEqual(queue.dequeue()?.id, 'c');
  });
}

async function testConcurrency() {
  console.log('\n🔀 Concurrency Tests');

  await test('respects maxConcurrent limit', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2 });

    let concurrent = 0;
    let maxConcurrent = 0;

    const job = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(50);
      concurrent--;
    };

    await Promise.all(Array.from({ length: 5 }, () => limiter.schedule(job)));

    assertEqual(maxConcurrent, 2, `Max concurrent was ${maxConcurrent}`);
  });

  await test('respects job weight', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 3 });

    let concurrent = 0;
    let maxConcurrent = 0;

    const heavyJob = async () => {
      concurrent += 2;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(50);
      concurrent -= 2;
    };

    const lightJob = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(50);
      concurrent--;
    };

    await Promise.all([
      limiter.schedule({ weight: 2 }, heavyJob),
      limiter.schedule({ weight: 1 }, lightJob),
      limiter.schedule({ weight: 2 }, heavyJob),
    ]);

    assert(maxConcurrent <= 3, `Max concurrent was ${maxConcurrent}, expected <= 3`);
  });
}

async function testRateLimiting() {
  console.log('\n⏱️  Rate Limiting Tests');

  await test('respects minTime between jobs', async () => {
    const limiter = new RateLimiter({ minTime: 50 });

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
      assert(diff >= 45, `Time between jobs was ${diff}ms, expected >= 50ms`);
    }
  });

  await test('respects maxPerInterval', async () => {
    const limiter = new RateLimiter({
      maxPerInterval: 2,
      interval: 100,
    });

    const timestamps: number[] = [];
    const start = Date.now();

    await Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.schedule(async () => {
          timestamps.push(Date.now() - start);
        })
      )
    );

    // First 2 should be immediate, next 2 should be after interval
    assert(timestamps[0] < 50, 'First job should be immediate');
    assert(timestamps[1] < 50, 'Second job should be immediate');
    assert(timestamps[2] >= 90, `Third job should be after interval: ${timestamps[2]}`);
    assert(timestamps[3] >= 90, `Fourth job should be after interval: ${timestamps[3]}`);
  });
}

async function testReservoir() {
  console.log('\n🪣 Reservoir Tests');

  await test('limits execution by reservoir', async () => {
    const limiter = new RateLimiter({ reservoir: 2 });

    let executed = 0;
    let depleted = false;

    limiter.on('depleted', () => {
      depleted = true;
    });

    // Schedule 3 jobs but only 2 should execute
    const jobs = Array.from({ length: 3 }, () =>
      limiter.schedule(async () => {
        executed++;
      })
    );

    // Wait for the first 2
    await Promise.race([
      Promise.all(jobs),
      sleep(200),
    ]);

    assertEqual(executed, 2, `Expected 2 executed, got ${executed}`);
    assert(depleted, 'Should have emitted depleted event');

    await limiter.stop();
  });

  await test('updateReservoir allows more execution', async () => {
    const limiter = new RateLimiter({ reservoir: 1 });

    let executed = 0;

    const job1 = limiter.schedule(async () => {
      executed++;
      return 1;
    });

    const job2 = limiter.schedule(async () => {
      executed++;
      return 2;
    });

    await job1;
    assertEqual(executed, 1);

    // Update reservoir
    limiter.updateReservoir(1);
    await job2;

    assertEqual(executed, 2);
    await limiter.stop();
  });
}

async function testPriority() {
  console.log('\n⭐ Priority Tests');

  await test('executes higher priority jobs first', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });

    const order: string[] = [];

    // First job starts immediately
    const first = limiter.schedule({ id: 'first' }, async () => {
      await sleep(20);
      order.push('first');
    });

    // Queue jobs with different priorities
    const low = limiter.schedule({ id: 'low', priority: Priority.LOW }, async () => {
      order.push('low');
    });

    const high = limiter.schedule({ id: 'high', priority: Priority.HIGH }, async () => {
      order.push('high');
    });

    const critical = limiter.schedule({ id: 'critical', priority: Priority.CRITICAL }, async () => {
      order.push('critical');
    });

    await Promise.all([first, low, high, critical]);

    // First job completes first, then priority order
    assertEqual(order[0], 'first');
    assertEqual(order[1], 'critical');
    assertEqual(order[2], 'high');
    assertEqual(order[3], 'low');
  });
}

async function testEvents() {
  console.log('\n📡 Event Tests');

  await test('emits lifecycle events', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });

    const events: string[] = [];

    limiter.on('queued', () => events.push('queued'));
    limiter.on('executing', () => events.push('executing'));
    limiter.on('done', () => events.push('done'));
    limiter.on('idle', () => events.push('idle'));

    await limiter.schedule(async () => 'result');

    assert(events.includes('queued'), 'Should emit queued');
    assert(events.includes('executing'), 'Should emit executing');
    assert(events.includes('done'), 'Should emit done');
    assert(events.includes('idle'), 'Should emit idle');
  });

  await test('emits failed event on error', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });

    let failedEmitted = false;

    limiter.on('failed', () => {
      failedEmitted = true;
    });

    try {
      await limiter.schedule(async () => {
        throw new Error('Test error');
      });
    } catch {
      // Expected
    }

    assert(failedEmitted, 'Should emit failed event');
  });
}

async function testRetry() {
  console.log('\n🔄 Retry Tests');

  await test('retries failed jobs', async () => {
    const limiter = new RateLimiter({
      retryCount: 2,
      retryDelay: 10,
    });

    let attempts = 0;

    await limiter.schedule(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Fail');
      }
      return 'success';
    });

    assertEqual(attempts, 3, `Expected 3 attempts, got ${attempts}`);
  });

  await test('uses exponential backoff', async () => {
    const limiter = new RateLimiter({
      retryCount: 2,
      retryDelay: (attempt) => attempt * 50,
    });

    const timestamps: number[] = [];

    try {
      await limiter.schedule(async () => {
        timestamps.push(Date.now());
        throw new Error('Fail');
      });
    } catch {
      // Expected
    }

    // Should have 3 attempts
    assertEqual(timestamps.length, 3, `Expected 3 attempts, got ${timestamps.length}`);

    // Check delays
    const delay1 = timestamps[1] - timestamps[0];
    const delay2 = timestamps[2] - timestamps[1];

    assert(delay1 >= 40, `First retry delay was ${delay1}ms, expected ~50ms`);
    assert(delay2 >= 90, `Second retry delay was ${delay2}ms, expected ~100ms`);
  });
}

async function testCancellation() {
  console.log('\n❌ Cancellation Tests');

  await test('cancels queued job by ID', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });

    // Block the limiter
    const blocking = limiter.schedule(async () => {
      await sleep(100);
    });

    // Queue a job to cancel
    const toCancel = limiter.schedule({ id: 'cancel-me' }, async () => {
      return 'should not run';
    });

    // Cancel it
    const cancelled = limiter.cancel('cancel-me');
    assert(cancelled, 'Should return true when cancelling');

    try {
      await toCancel;
      throw new Error('Should have thrown');
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes('cancelled'),
        'Should throw cancelled error'
      );
    }

    await blocking;
  });

  await test('supports AbortController', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });

    const controller = new AbortController();

    // Block the limiter
    const blocking = limiter.schedule(async () => {
      await sleep(100);
    });

    // Queue a job with signal
    const abortable = limiter.schedule(
      { signal: controller.signal },
      async () => 'should not run'
    );

    // Abort it
    controller.abort();

    try {
      await abortable;
      throw new Error('Should have thrown');
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes('aborted'),
        'Should throw aborted error'
      );
    }

    await blocking;
  });
}

async function testWrap() {
  console.log('\n🎁 Wrap Function Tests');

  await test('wraps function with rate limiting', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });

    let concurrent = 0;
    let maxConcurrent = 0;

    const wrapped = limiter.wrap(async (n: number) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(10);
      concurrent--;
      return n * 2;
    });

    const results = await Promise.all([wrapped(1), wrapped(2), wrapped(3)]);

    assertEqual(maxConcurrent, 1);
    assertEqual(results[0], 2);
    assertEqual(results[1], 4);
    assertEqual(results[2], 6);
  });
}

async function testStats() {
  console.log('\n📊 Stats Tests');

  await test('tracks statistics correctly', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2 });

    // Run some jobs
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.schedule(async () => {
          await sleep(10);
        })
      )
    );

    // Fail one
    try {
      await limiter.schedule(async () => {
        throw new Error('Fail');
      });
    } catch {
      // Expected
    }

    const stats = limiter.getStats();

    assertEqual(stats.done, 5, `Expected 5 done, got ${stats.done}`);
    assertEqual(stats.failed, 1, `Expected 1 failed, got ${stats.failed}`);
    assert(stats.avgExecutionTime > 0, 'Should have avg execution time');
  });
}

// Run all tests
async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║      RateLimiter Tests                 ║');
  console.log('╚════════════════════════════════════════╝');

  await testPriorityQueue();
  await testConcurrency();
  await testRateLimiting();
  await testReservoir();
  await testPriority();
  await testEvents();
  await testRetry();
  await testCancellation();
  await testWrap();
  await testStats();

  console.log('\n════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);

