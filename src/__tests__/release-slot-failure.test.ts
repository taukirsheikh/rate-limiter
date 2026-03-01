/**
 * Focused test: When releaseSlot() throws in the catch block (e.g. Redis down),
 * does the job promise settle (resolve or reject) or hang?
 *
 * Run: npx tsx src/__tests__/release-slot-failure.test.ts
 * Requires: Redis at localhost:6379
 */

import { DistributedRateLimiter } from '../index.js';
import type { RedisStorage } from '../redis/redis-storage.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function main() {
  console.log('Test: Job promise when releaseSlot() throws in catch block\n');

  const limiter = new DistributedRateLimiter({
    id: `release-fail-${Date.now()}`,
    redis: { url: REDIS_URL, keyPrefix: 'test:ratelimit' },
    clearOnStart: true,
    maxConcurrent: 2,
  });

  try {
    await limiter.ready();
  } catch (e) {
    console.log('⊘ Redis not available, skipping test');
    process.exit(0);
  }

  const storage = limiter.getStorage();
  const originalRelease = storage.releaseSlot.bind(storage);

  // Replace releaseSlot: first call succeeds (for normal path), we'll force fail on the catch-path
  let releaseCallCount = 0;
  (storage as any).releaseSlot = async (
    limiterId: string,
    jobId: string,
    weight: number,
    success: boolean
  ) => {
    releaseCallCount++;
    // When success is false (job failed), make releaseSlot throw to simulate Redis down
    if (!success) {
      throw new Error('Simulated Redis failure on release');
    }
    return originalRelease(limiterId, jobId, weight, success);
  };

  let jobSettled = false;
  let settledWith: 'resolve' | 'reject' | null = null;
  let settledError: Error | null = null;
  let unhandledRejection: Error | null = null;

  process.on('unhandledRejection', (reason) => {
    unhandledRejection = reason instanceof Error ? reason : new Error(String(reason));
  });

  const jobPromise = limiter
    .schedule(async () => {
      throw new Error('Job fails intentionally');
    })
    .then(
      () => {
        jobSettled = true;
        settledWith = 'resolve';
      },
      (err) => {
        jobSettled = true;
        settledWith = 'reject';
        settledError = err instanceof Error ? err : new Error(String(err));
      }
    );

  // Wait up to 5s for the job to settle
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('Timeout: job did not settle within 5s')), 5000)
  );

  try {
    await Promise.race([jobPromise, timeout]);
  } catch (e) {
    if ((e as Error).message?.startsWith('Timeout')) {
      console.log('✗ FAIL: Job promise did NOT settle when releaseSlot() threw (timeout).');
      console.log('  Claim in PRODUCTION-READINESS.md is VERIFIED: job can hang.');
      await limiter.stop();
      process.exit(1);
    }
    throw e;
  }

  await limiter.stop();

  // If releaseSlot threw, we often get unhandledRejection or job never settles
  if (unhandledRejection) {
    console.log('✗ FAIL: Unhandled rejection when releaseSlot() threw:', unhandledRejection.message);
    console.log('  Claim in PRODUCTION-READINESS.md is VERIFIED: job promise not settled, error propagates.');
    process.exit(1);
  }

  if (jobSettled && settledWith === 'reject') {
    console.log('✓ PASS: Job promise rejects even when releaseSlot() throws (bug fixed).');
    console.log('  Rejected with:', settledError?.message ?? settledError);
    process.exit(0);
  }

  if (jobSettled && settledWith === 'resolve') {
    console.log('✗ UNEXPECTED: Job resolved (should have rejected - job threw).');
    process.exit(1);
  }

  console.log('? Unknown state:', { jobSettled, settledWith, settledError });
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
