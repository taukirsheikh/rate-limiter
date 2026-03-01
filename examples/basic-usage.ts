/**
 * Basic usage examples for the RateLimiter
 */

import { RateLimiter, Priority } from '../src/index.js';

// Simulate an API call
const fakeApiCall = async (id: number, delay = 100): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return `Response from API call ${id}`;
};

async function basicExample() {
  console.log('\n🚀 Basic Example');
  console.log('================');

  const limiter = new RateLimiter({
    maxConcurrent: 2, // Max 2 concurrent requests
    minTime: 50, // 50ms minimum between requests
  });

  // Listen for events
  limiter.on('executing', ({ job, running }) => {
    console.log(`  ▶ Executing job ${job.id} (${running} running)`);
  });

  limiter.on('done', ({ job, duration }) => {
    console.log(`  ✓ Job ${job.id} completed in ${duration}ms`);
  });

  // Schedule some jobs
  const results = await Promise.all([
    limiter.schedule({ id: 'job-1' }, () => fakeApiCall(1)),
    limiter.schedule({ id: 'job-2' }, () => fakeApiCall(2)),
    limiter.schedule({ id: 'job-3' }, () => fakeApiCall(3)),
    limiter.schedule({ id: 'job-4' }, () => fakeApiCall(4)),
  ]);

  console.log('  Results:', results);
}

async function priorityExample() {
  console.log('\n⭐ Priority Example');
  console.log('===================');

  const limiter = new RateLimiter({
    maxConcurrent: 1, // Only 1 at a time to show priority ordering
  });

  const order: string[] = [];

  limiter.on('done', ({ job }) => {
    order.push(job.id);
  });

  // Queue jobs with different priorities
  const promises = [
    limiter.schedule({ id: 'low', priority: Priority.LOW }, () => fakeApiCall(1, 10)),
    limiter.schedule({ id: 'normal', priority: Priority.NORMAL }, () => fakeApiCall(2, 10)),
    limiter.schedule({ id: 'high', priority: Priority.HIGH }, () => fakeApiCall(3, 10)),
    limiter.schedule({ id: 'critical', priority: Priority.CRITICAL }, () => fakeApiCall(4, 10)),
  ];

  await Promise.all(promises);
  console.log('  Execution order:', order);
  console.log('  (First was already running, rest ordered by priority)');
}

async function rateLimitExample() {
  console.log('\n⏱️  Rate Limiting Example');
  console.log('=========================');

  const limiter = new RateLimiter({
    maxConcurrent: 10,
    maxPerInterval: 3, // Max 3 requests per interval
    interval: 1000, // 1 second interval
  });

  console.log('  Scheduling 6 requests (limited to 3/second)...');
  const start = Date.now();

  const promises = Array.from({ length: 6 }, (_, i) =>
    limiter.schedule({ id: `req-${i + 1}` }, async () => {
      const elapsed = Date.now() - start;
      console.log(`    Request ${i + 1} executed at ${elapsed}ms`);
      return i;
    })
  );

  await Promise.all(promises);
  console.log(`  Total time: ${Date.now() - start}ms`);
}

async function reservoirExample() {
  console.log('\n🪣 Reservoir (Token Bucket) Example');
  console.log('====================================');

  const limiter = new RateLimiter({
    reservoir: 3, // Start with 3 tokens
    reservoirRefreshInterval: 1000, // Refill every second
    reservoirRefreshAmount: 3, // Refill to 3 tokens
  });

  limiter.on('depleted', () => {
    console.log('  ⚠️ Reservoir depleted, waiting for refill...');
  });

  console.log('  Starting with 3 tokens, refills to 3 every second');

  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      limiter.schedule(async () => {
        const elapsed = Date.now() - start;
        console.log(`    Job ${i + 1} executed at ${elapsed}ms`);
        return i;
      })
    )
  );

  console.log('  Results:', results);
  await limiter.stop();
}

async function wrapFunctionExample() {
  console.log('\n🎁 Wrap Function Example');
  console.log('========================');

  const limiter = new RateLimiter({
    maxConcurrent: 1,
    minTime: 100,
  });

  // Wrap an existing function
  const rateLimitedFetch = limiter.wrap(async (url: string) => {
    console.log(`    Fetching: ${url}`);
    await new Promise((r) => setTimeout(r, 50));
    return `Data from ${url}`;
  });

  // Use it like a normal function
  const results = await Promise.all([
    rateLimitedFetch('/api/users'),
    rateLimitedFetch('/api/posts'),
    rateLimitedFetch('/api/comments'),
  ]);

  console.log('  Results:', results);
}

async function retryExample() {
  console.log('\n🔄 Retry Example');
  console.log('================');

  let attempts = 0;

  const limiter = new RateLimiter({
    retryCount: 3,
    retryDelay: (attempt) => attempt * 100, // Exponential backoff
  });

  limiter.on('retry', ({ attempt, error }) => {
    console.log(`  ↻ Retry attempt ${attempt}: ${error.message}`);
  });

  try {
    await limiter.schedule(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error(`Failed on attempt ${attempts}`);
      }
      return 'Success!';
    });
    console.log(`  ✓ Succeeded after ${attempts} attempts`);
  } catch (error) {
    console.log(`  ✗ Failed after ${attempts} attempts`);
  }
}

async function cancelExample() {
  console.log('\n❌ Cancellation Example');
  console.log('=======================');

  const limiter = new RateLimiter({
    maxConcurrent: 1,
  });

  // Schedule a job that will be cancelled
  const controller = new AbortController();

  const promise = limiter.schedule(
    { id: 'cancellable-job', signal: controller.signal },
    async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return 'This should not complete';
    }
  );

  // Cancel after 100ms
  setTimeout(() => {
    controller.abort();
    console.log('  Job aborted via signal');
  }, 100);

  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      console.log(`  Caught: ${error.message}`);
    }
  }
}

async function statsExample() {
  console.log('\n📊 Stats Example');
  console.log('================');

  const limiter = new RateLimiter({
    maxConcurrent: 2,
  });

  // Run some jobs
  await Promise.all(
    Array.from({ length: 5 }, () =>
      limiter.schedule(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 100));
      })
    )
  );

  const stats = limiter.getStats();
  console.log('  Stats:', {
    done: stats.done,
    avgWaitTime: `${stats.avgWaitTime.toFixed(2)}ms`,
    avgExecutionTime: `${stats.avgExecutionTime.toFixed(2)}ms`,
  });
}

// Run all examples
async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║      RateLimiter Examples              ║');
  console.log('╚════════════════════════════════════════╝');

  await basicExample();
  await priorityExample();
  await rateLimitExample();
  await reservoirExample();
  await wrapFunctionExample();
  await retryExample();
  await cancelExample();
  await statsExample();

  console.log('\n✅ All examples completed!\n');
}

main().catch(console.error);

