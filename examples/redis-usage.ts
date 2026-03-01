/**
 * Redis/Distributed usage examples for the RateLimiter
 *
 * These examples demonstrate how to use the DistributedRateLimiter
 * for rate limiting across multiple servers/processes.
 *
 * Prerequisites:
 * - Redis server running on localhost:6379
 *
 * Run with: npm run example:redis
 */

import { DistributedRateLimiter, Priority } from '../src/index.js';

// Check if Redis is available
async function checkRedis(): Promise<boolean> {
  try {
    const limiter = new DistributedRateLimiter({
      id: 'redis-check',
      redis: { host: 'localhost', port: 6379 },
    });
    await limiter.ready();
    await limiter.stop();
    return true;
  } catch {
    return false;
  }
}

// Simulate an API call
const fakeApiCall = async (id: number, delay = 100): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return `Response from API call ${id}`;
};

async function basicDistributedExample() {
  console.log('\n🌐 Basic Distributed Example');
  console.log('============================');

  const limiter = new DistributedRateLimiter({
    id: 'api-limiter',
    maxConcurrent: 2,
    minTime: 50,
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'example:ratelimit',
    },
    clearOnStart: true, // Clear previous state for clean example
  });

  await limiter.ready();
  console.log('  ✓ Connected to Redis');

  // Listen for events
  limiter.on('executing', ({ job }) => {
    console.log(`  ▶ Executing job ${job.id}`);
  });

  limiter.on('done', ({ job, duration }) => {
    console.log(`  ✓ Job ${job.id} completed in ${duration}ms`);
  });

  // Schedule jobs
  const results = await Promise.all([
    limiter.schedule({ id: 'job-1' }, () => fakeApiCall(1)),
    limiter.schedule({ id: 'job-2' }, () => fakeApiCall(2)),
    limiter.schedule({ id: 'job-3' }, () => fakeApiCall(3)),
    limiter.schedule({ id: 'job-4' }, () => fakeApiCall(4)),
  ]);

  console.log('  Results:', results);

  // Check distributed state
  const state = await limiter.getState();
  console.log('  Distributed state:', state);

  await limiter.stop();
}

async function multiInstanceSimulation() {
  console.log('\n🔗 Multi-Instance Simulation');
  console.log('============================');
  console.log('  Simulating 3 server instances sharing rate limits...\n');

  // Create multiple limiter instances (simulating multiple servers)
  const instances = await Promise.all(
    [1, 2, 3].map(async (i) => {
      const limiter = new DistributedRateLimiter({
        id: 'shared-limiter', // Same ID = shared limits
        maxConcurrent: 2, // Max 2 concurrent across ALL instances
        minTime: 100,
        redis: {
          host: 'localhost',
          port: 6379,
          keyPrefix: 'multiinstance',
        },
        clearOnStart: i === 1, // Only first instance clears
      });

      await limiter.ready();

      limiter.on('executing', ({ job }) => {
        console.log(`    [Instance ${i}] ▶ Executing ${job.id}`);
      });

      limiter.on('done', ({ job }) => {
        console.log(`    [Instance ${i}] ✓ Completed ${job.id}`);
      });

      return { instance: i, limiter };
    })
  );

  console.log('  All instances connected and sharing "shared-limiter"\n');

  // Each instance schedules a job
  const start = Date.now();
  const promises = instances.map(({ instance, limiter }) =>
    limiter.schedule(
      { id: `instance-${instance}-job` },
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return `Result from instance ${instance}`;
      }
    )
  );

  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  console.log(`\n  All jobs completed in ${elapsed}ms`);
  console.log('  Results:', results);
  console.log('  (With maxConcurrent=2, some jobs had to wait)\n');

  // Check shared state
  const state = await instances[0].limiter.getState();
  console.log('  Shared state:', state);

  // Cleanup
  await Promise.all(instances.map(({ limiter }) => limiter.stop()));
}

async function distributedReservoir() {
  console.log('\n🪣 Distributed Reservoir Example');
  console.log('=================================');

  const limiter = new DistributedRateLimiter({
    id: 'token-bucket',
    reservoir: 3,
    reservoirRefreshInterval: 2000,
    reservoirRefreshAmount: 3,
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'reservoir',
    },
    clearOnStart: true,
  });

  await limiter.ready();

  limiter.on('depleted', () => {
    console.log('  ⚠️ Reservoir depleted across all instances');
  });

  console.log('  Starting with 3 tokens (shared across all instances)');

  const start = Date.now();

  // Schedule 5 jobs - only 3 will run immediately
  const promises = Array.from({ length: 5 }, (_, i) =>
    limiter.schedule(async () => {
      const elapsed = Date.now() - start;
      console.log(`    Job ${i + 1} executed at ${elapsed}ms`);
      return i;
    })
  );

  await Promise.all(promises);
  console.log(`  Total time: ${Date.now() - start}ms`);

  await limiter.stop();
}

async function distributedWithPriority() {
  console.log('\n⭐ Distributed Priority Example');
  console.log('================================');

  const limiter = new DistributedRateLimiter({
    id: 'priority-limiter',
    maxConcurrent: 1,
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'priority',
    },
    clearOnStart: true,
  });

  await limiter.ready();

  const order: string[] = [];

  limiter.on('done', ({ job }) => {
    order.push(job.id);
  });

  // First job starts immediately
  const first = limiter.schedule({ id: 'first' }, async () => {
    await new Promise((r) => setTimeout(r, 50));
    return 'first';
  });

  // Queue with priorities
  const low = limiter.schedule(
    { id: 'low', priority: Priority.LOW },
    async () => 'low'
  );
  const high = limiter.schedule(
    { id: 'high', priority: Priority.HIGH },
    async () => 'high'
  );
  const critical = limiter.schedule(
    { id: 'critical', priority: Priority.CRITICAL },
    async () => 'critical'
  );

  await Promise.all([first, low, high, critical]);

  console.log('  Execution order:', order);
  console.log('  (First was running, rest queued by priority)');

  await limiter.stop();
}

async function failoverExample() {
  console.log('\n🔄 Graceful Degradation Example');
  console.log('================================');

  // This shows how the limiter handles Redis being unavailable
  console.log('  Testing connection to invalid Redis...');

  try {
    const limiter = new DistributedRateLimiter({
      id: 'failover-test',
      maxConcurrent: 5,
      redis: {
        host: 'invalid-host',
        port: 9999,
        redisOptions: {
          connectTimeout: 1000,
          maxRetriesPerRequest: 1,
        },
      },
    });

    await limiter.ready();
  } catch (error) {
    console.log('  ✓ Caught error:', (error as Error).message.substring(0, 50) + '...');
    console.log('  (Application can fall back to local RateLimiter)');
  }
}

async function statsExample() {
  console.log('\n📊 Distributed Stats Example');
  console.log('============================');

  const limiter = new DistributedRateLimiter({
    id: 'stats-limiter',
    maxConcurrent: 3,
    redis: {
      host: 'localhost',
      port: 6379,
      keyPrefix: 'stats',
    },
    clearOnStart: true,
  });

  await limiter.ready();

  // Run some jobs
  await Promise.all(
    Array.from({ length: 10 }, () =>
      limiter.schedule(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 100));
        return 'done';
      })
    )
  );

  const stats = await limiter.getStats();
  console.log('  Distributed stats:', {
    done: stats.done,
    failed: stats.failed,
    avgWaitTime: `${stats.avgWaitTime.toFixed(2)}ms`,
    avgExecutionTime: `${stats.avgExecutionTime.toFixed(2)}ms`,
  });

  await limiter.stop();
}

// Main
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Distributed RateLimiter Examples         ║');
  console.log('╚════════════════════════════════════════════╝');

  // Check Redis availability
  const redisAvailable = await checkRedis();

  if (!redisAvailable) {
    console.log('\n⚠️  Redis is not available at localhost:6379');
    console.log('   Please start Redis to run these examples:\n');
    console.log('   docker run -d -p 6379:6379 redis:alpine');
    console.log('   # or');
    console.log('   brew services start redis\n');

    await failoverExample();
    return;
  }

  console.log('\n✓ Redis connected at localhost:6379');

  await basicDistributedExample();
  await multiInstanceSimulation();
  await distributedReservoir();
  await distributedWithPriority();
  await statsExample();
  await failoverExample();

  console.log('\n✅ All distributed examples completed!\n');
}

main().catch(console.error);

