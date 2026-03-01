# @taukirsheikh/rate-limiter

Control how many tasks run at once and how fast they start. Use it when you're calling an API that has rate limits, or when you want to avoid overloading a service.

**Install**

```bash
npm install @taukirsheikh/rate-limiter
```

**Your first limiter**

```javascript
import { RateLimiter } from '@taukirsheikh/rate-limiter';

const limiter = new RateLimiter({
  maxConcurrent: 2,   // only 2 requests at a time
  minTime: 500,       // wait 500ms between starting each one
});

// Instead of firing 10 requests at once:
const result = await limiter.schedule(() => fetch('https://api.example.com/data'));
```

You get one shared queue: jobs wait their turn, and the limiter starts them according to your rules.

**Running across multiple servers?** Use Redis so every instance shares the same limits:

```javascript
import { DistributedRateLimiter } from '@taukirsheikh/rate-limiter';

const limiter = new DistributedRateLimiter({
  maxConcurrent: 10,
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
});
await limiter.ready();

const result = await limiter.schedule(() => fetch('https://api.example.com/data'));
```

**What you can do**

- Limit concurrency (e.g. max 5 at a time).
- Space out jobs (e.g. at least 100ms between starts).
- Cap jobs per minute/hour with `maxPerInterval` and `interval`.
- Use a token bucket with `reservoir` and refill options.
- Give jobs priority so important work runs first.
- Wrap any async function with `limiter.wrap(fn)`.
- Retry failed jobs with `retryCount` and `retryDelay`.
- Cancel with `limiter.cancel(jobId)` or an `AbortSignal`.

**Docs**

Full guides and API reference: **[docs.page/taukirsheikh/rate-limiter](https://docs.page/taukirsheikh/rate-limiter)**

**Try the examples**

```bash
npm run example        # in-memory limiter
npm run example:redis  # Redis (needs Redis running)
```

**License** — MIT
