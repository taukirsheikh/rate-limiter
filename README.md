# @taukirsheikh/rate-limiter

A powerful rate limiter for Node.js with TypeScript support and Redis clustering built from scratch.

## Features

- 🚦 **Concurrency Control** - Limit max concurrent jobs
- ⏱️ **Rate Limiting** - Min time between jobs, max per interval
- 🪣 **Reservoir (Token Bucket)** - Finite pool with automatic refill
- ⭐ **Priority Queues** - Higher priority jobs execute first
- 🔄 **Retry Support** - Automatic retries with exponential backoff
- ❌ **Cancellation** - Cancel by ID or AbortController
- 📡 **Event Hooks** - Lifecycle events for monitoring
- 📊 **Statistics** - Track wait times, execution times, success/failure
- 🎁 **Function Wrapping** - Easily wrap existing async functions
- 🌐 **Redis Clustering** - Distributed rate limiting across multiple servers

## Installation

```bash
npm install @taukirsheikh/rate-limiter
```

## Quick Start

```typescript
import { RateLimiter, Priority } from '@taukirsheikh/rate-limiter';

// Create a limiter
const limiter = new RateLimiter({
  maxConcurrent: 5,    // Max 5 concurrent requests
  minTime: 100,        // 100ms minimum between requests
});

// Schedule a job
const result = await limiter.schedule(async () => {
  return await fetch('https://api.example.com/data');
});
```

## Configuration Options

```typescript
interface RateLimiterOptions {
  // Concurrency
  maxConcurrent?: number;       // Max concurrent jobs (default: Infinity)

  // Rate Limiting
  minTime?: number;             // Min ms between job starts (default: 0)
  maxPerInterval?: number;      // Max jobs per interval (default: Infinity)
  interval?: number;            // Interval duration in ms (default: 1000)

  // Reservoir (Token Bucket)
  reservoir?: number;           // Initial reservoir size
  reservoirRefreshInterval?: number;  // Refill interval in ms
  reservoirRefreshAmount?: number;    // Amount to refill

  // Queue Management
  highWater?: number;           // Max queue size
  strategy?: 'leak' | 'overflow' | 'block';  // Overflow strategy

  // Retry
  retryCount?: number;          // Auto-retry count (default: 0)
  retryDelay?: number | ((attempt, error) => number);  // Retry delay

  // Other
  timeout?: number;             // Job timeout in ms
  id?: string;                  // Limiter instance ID
}
```

## Examples

### Basic Rate Limiting

```typescript
const limiter = new RateLimiter({
  maxConcurrent: 2,
  minTime: 100,
});

const results = await Promise.all([
  limiter.schedule(() => fetchUser(1)),
  limiter.schedule(() => fetchUser(2)),
  limiter.schedule(() => fetchUser(3)),
]);
```

### Priority Queuing

```typescript
import { Priority } from '@taukirsheikh/rate-limiter';

// Critical jobs run first
await limiter.schedule(
  { priority: Priority.CRITICAL },
  () => handleUrgentRequest()
);

// Low priority runs when queue is free
await limiter.schedule(
  { priority: Priority.LOW },
  () => backgroundSync()
);
```

### Reservoir (Token Bucket)

```typescript
const limiter = new RateLimiter({
  reservoir: 10,                    // Start with 10 tokens
  reservoirRefreshInterval: 60000,  // Refill every minute
  reservoirRefreshAmount: 10,       // Refill to 10 tokens
});

// Each request uses 1 token
// After 10 requests, must wait for refill
```

### Wrap Existing Functions

```typescript
const rateLimitedFetch = limiter.wrap(
  async (url: string) => {
    const response = await fetch(url);
    return response.json();
  }
);

// Use like a normal function
const data = await rateLimitedFetch('/api/users');
```

### Retry with Exponential Backoff

```typescript
const limiter = new RateLimiter({
  retryCount: 3,
  retryDelay: (attempt, error) => Math.pow(2, attempt) * 1000,
});

// Will retry up to 3 times: 2s, 4s, 8s delays
await limiter.schedule(() => unreliableApiCall());
```

### Cancellation

```typescript
// Cancel by ID
limiter.schedule({ id: 'my-job' }, async () => { ... });
limiter.cancel('my-job');

// Cancel with AbortController
const controller = new AbortController();
limiter.schedule(
  { signal: controller.signal },
  async () => { ... }
);
controller.abort();
```

### Event Monitoring

```typescript
limiter.on('executing', ({ job, running }) => {
  console.log(`Starting ${job.id}, ${running} jobs running`);
});

limiter.on('done', ({ job, duration }) => {
  console.log(`Completed ${job.id} in ${duration}ms`);
});

limiter.on('failed', ({ job, error, willRetry }) => {
  console.log(`Failed ${job.id}: ${error.message}`);
});

limiter.on('depleted', () => {
  console.log('Reservoir empty, waiting for refill');
});

limiter.on('idle', () => {
  console.log('All jobs complete');
});
```

### Statistics

```typescript
const stats = limiter.getStats();
console.log({
  running: stats.running,
  queued: stats.queued,
  done: stats.done,
  failed: stats.failed,
  avgWaitTime: stats.avgWaitTime,
  avgExecutionTime: stats.avgExecutionTime,
});
```

---

## 🌐 Distributed Rate Limiting with Redis

For multi-server deployments, use `DistributedRateLimiter` to coordinate rate limits across all instances using Redis.

### Quick Start (Redis)

```typescript
import { DistributedRateLimiter } from '@taukirsheikh/rate-limiter';

const limiter = new DistributedRateLimiter({
  id: 'api-limiter',          // Shared ID across all servers
  maxConcurrent: 10,          // 10 concurrent across ALL instances
  minTime: 100,
  redis: {
    host: 'localhost',
    port: 6379,
    keyPrefix: 'myapp:ratelimit',
  },
});

// Wait for Redis connection
await limiter.ready();

// Use like normal RateLimiter
const result = await limiter.schedule(async () => {
  return await fetch('https://api.example.com/data');
});
```

### Using a Redis URL

You can pass a connection URL instead of host/port:

```typescript
import { DistributedRateLimiter } from '@taukirsheikh/rate-limiter';

// With a URL string (e.g. redis://localhost:6379)
const limiter = new DistributedRateLimiter({
  id: 'api-limiter',
  maxConcurrent: 10,
  minTime: 100,
  redis: {
    url: 'redis://localhost:6379',
    keyPrefix: 'myapp:ratelimit',
  },
});

await limiter.ready();
```

Supported URL forms: `redis://localhost:6379`, `rediss://...` (TLS), and URLs with auth (e.g. `redis://:password@host:6379`).

### Redis Configuration

```typescript
interface RedisConnectionOptions {
  // Connection
  url?: string;                    // Redis URL (redis://...)
  host?: string;                   // Redis host (default: localhost)
  port?: number;                   // Redis port (default: 6379)
  password?: string;               // Redis password
  db?: number;                     // Database number

  // Clustering
  cluster?: boolean;               // Use Redis Cluster
  clusterNodes?: Array<{host: string; port: number}>;

  // Namespacing
  keyPrefix?: string;              // Key prefix (default: 'ratelimit')

  // Advanced
  client?: Redis | Cluster;        // Existing ioredis client
  redisOptions?: RedisOptions;     // Additional ioredis options
}
```

### Multi-Server Example

```typescript
// Server 1
const limiter1 = new DistributedRateLimiter({
  id: 'shared-limiter',       // Same ID = shared limits
  maxConcurrent: 5,
  redis: { host: 'redis.example.com' },
});

// Server 2 (different machine)
const limiter2 = new DistributedRateLimiter({
  id: 'shared-limiter',       // Same ID!
  maxConcurrent: 5,
  redis: { host: 'redis.example.com' },
});

// Both servers share the 5 concurrent slot limit
// If Server 1 has 3 running, Server 2 can only run 2
```

### Distributed Reservoir

```typescript
const limiter = new DistributedRateLimiter({
  id: 'token-bucket',
  reservoir: 100,                    // 100 tokens shared across all servers
  reservoirRefreshInterval: 60000,   // Refill every minute
  reservoirRefreshAmount: 100,
  redis: { host: 'localhost' },
});

// All instances share the 100 token pool
```

### Redis Cluster Support

```typescript
const limiter = new DistributedRateLimiter({
  id: 'cluster-limiter',
  maxConcurrent: 50,
  redis: {
    cluster: true,
    clusterNodes: [
      { host: 'redis-1.example.com', port: 6379 },
      { host: 'redis-2.example.com', port: 6379 },
      { host: 'redis-3.example.com', port: 6379 },
    ],
  },
});
```

### Using Existing Redis Client

```typescript
import Redis from 'ioredis';

const redis = new Redis({ host: 'localhost', port: 6379 });

const limiter = new DistributedRateLimiter({
  id: 'shared-client',
  maxConcurrent: 10,
  redis: {
    client: redis,  // Use existing client
  },
});
```

### Distributed Options

```typescript
interface DistributedRateLimiterOptions extends RateLimiterOptions {
  redis: RedisConnectionOptions;

  // Polling interval when waiting for slot (default: 50ms)
  pollInterval?: number;

  // Heartbeat interval to keep state alive (default: 30000ms)
  heartbeatInterval?: number;

  // Clear Redis state on start - useful for testing (default: false)
  clearOnStart?: boolean;
}
```

### How It Works

The distributed limiter uses **Lua scripts** for atomic operations:

1. **Acquire Slot**: Atomically checks concurrency, rate limits, and reservoir
2. **Release Slot**: Atomically decrements running count and updates stats
3. **All state lives in Redis**: Running count, interval counters, reservoir

This ensures that even with multiple servers hitting Redis simultaneously, the rate limits are enforced correctly without race conditions.

### State Persistence

```typescript
// State persists in Redis even when servers restart
const state = await limiter.getState();
console.log({
  running: state.running,     // Currently running (across all servers)
  done: state.done,           // Total completed
  failed: state.failed,       // Total failed
  reservoir: state.reservoir, // Current reservoir level
});
```

### When Redis is unavailable

- **At startup**: `ready()` waits for a connection (default timeout 5 seconds). If Redis is unreachable, `ready()` **rejects** with the connection error or `"Redis connection timeout"`. You must call `await limiter.ready()` before using the limiter; catch this error to handle startup failure.
- **After connection**: If Redis goes away later, Redis commands (e.g. acquire/release slot) will **reject**. The limiter emits an `'error'` event for these. Queued jobs may stay queued until Redis is back; in-flight jobs will see their promise reject when a Redis call fails. The underlying client (ioredis) auto-reconnects by default, so transient failures may recover.
- **Recommended**: Use the graceful degradation pattern below so your app can fall back to a local limiter when Redis is not available.

### Graceful Degradation

```typescript
import { RateLimiter, DistributedRateLimiter } from '@taukirsheikh/rate-limiter';

let limiter: RateLimiter | DistributedRateLimiter;

try {
  limiter = new DistributedRateLimiter({
    id: 'api-limiter',
    redis: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  });
  await limiter.ready();
} catch (error) {
  console.warn('Redis unavailable, falling back to local limiter', error);
  limiter = new RateLimiter({ maxConcurrent: 5, minTime: 100 });
}

// Use limiter.schedule(...) for both
```

---

## API Reference

### `RateLimiter`

#### Methods

| Method | Description |
|--------|-------------|
| `schedule(fn)` | Schedule a job for execution |
| `schedule(options, fn)` | Schedule with options |
| `wrap(fn, options?)` | Create a rate-limited version of a function |
| `scheduleAll(jobs)` | Schedule multiple jobs |
| `pause()` | Pause processing |
| `resume()` | Resume processing |
| `stop()` | Stop and reject all pending jobs |
| `cancel(jobId)` | Cancel a specific job |
| `waitForIdle()` | Wait for all jobs to complete |
| `getState()` | Get current limiter state |
| `getStats()` | Get detailed statistics |
| `getQueued()` | Get queued jobs |
| `updateReservoir(value)` | Set reservoir value |
| `incrementReservoir(amount)` | Add to reservoir |
| `isIdle()` | Check if limiter is idle |

#### Events

| Event | Data | Description |
|-------|------|-------------|
| `queued` | `{ job, position }` | Job added to queue |
| `executing` | `{ job, queued, running }` | Job started |
| `done` | `{ job, result, duration }` | Job completed |
| `failed` | `{ job, error, willRetry }` | Job failed |
| `retry` | `{ job, attempt, error }` | Job being retried |
| `dropped` | `{ job, reason }` | Job dropped (overflow) |
| `depleted` | - | Reservoir empty |
| `idle` | - | All jobs complete |
| `error` | `Error` | Error occurred |

### `JobOptions`

```typescript
interface JobOptions {
  priority?: number;      // Lower = higher priority (default: 5)
  weight?: number;        // Concurrent slots used (default: 1)
  id?: string;            // Unique job ID
  timeout?: number;       // Job-specific timeout
  retryCount?: number;    // Job-specific retry count
  signal?: AbortSignal;   // For cancellation
}
```

### `Priority` Enum

```typescript
enum Priority {
  CRITICAL = 0,
  HIGH = 3,
  NORMAL = 5,
  LOW = 7,
  IDLE = 9,
}
```

### `DistributedRateLimiter`

Same methods as `RateLimiter`, plus:

| Method | Description |
|--------|-------------|
| `ready()` | Wait for Redis connection (must call before use) |
| `getStorage()` | Get underlying RedisStorage instance |
| `clear()` | Clear all state from Redis |

**Note:** `getState()` and `getStats()` are async for the distributed limiter.

---

## Running the Examples

```bash
cd rate-limiter
npm install
npm run example          # Local rate limiter examples
npm run example:redis    # Distributed examples (requires Redis)
```

## Running Tests

```bash
npm test                 # Local rate limiter tests
npm test:redis           # Distributed tests (requires Redis)
```

### Starting Redis for Tests

```bash
# Docker
docker run -d -p 6379:6379 redis:alpine

# macOS
brew services start redis

# Linux
sudo systemctl start redis
```

## License

MIT

