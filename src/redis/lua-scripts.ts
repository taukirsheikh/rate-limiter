/**
 * Lua scripts for atomic Redis operations
 * These ensure race-condition-free distributed rate limiting
 */

/**
 * Acquire a slot for job execution
 * Returns: [allowed: 0|1, running: number, waitTime: number]
 *
 * KEYS[1]: limiter state key (hash)
 * ARGV[1]: max concurrent
 * ARGV[2]: min time (ms)
 * ARGV[3]: max per interval
 * ARGV[4]: interval (ms)
 * ARGV[5]: current timestamp (ms)
 * ARGV[6]: job weight
 * ARGV[7]: job id
 * ARGV[8]: reservoir refresh interval (ms, 0 = disabled)
 * ARGV[9]: reservoir refresh amount
 */
export const ACQUIRE_SLOT = `
local stateKey = KEYS[1]
local maxConcurrent = tonumber(ARGV[1])
local minTime = tonumber(ARGV[2])
local maxPerInterval = tonumber(ARGV[3])
local interval = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local weight = tonumber(ARGV[6])
local jobId = ARGV[7]
local refreshInterval = tonumber(ARGV[8] or '0')
local refreshAmount = tonumber(ARGV[9] or '0')

-- Get current state
local running = tonumber(redis.call('HGET', stateKey, 'running') or '0')
local currentWeight = tonumber(redis.call('HGET', stateKey, 'currentWeight') or '0')
local lastJobTime = tonumber(redis.call('HGET', stateKey, 'lastJobTime') or '0')
local intervalStart = tonumber(redis.call('HGET', stateKey, 'intervalStart') or '0')
local intervalCount = tonumber(redis.call('HGET', stateKey, 'intervalCount') or '0')
local reservoir = redis.call('HGET', stateKey, 'reservoir')

-- Lazily refresh the reservoir (single-writer by construction: whichever
-- process crosses the interval boundary first does the reset atomically)
if refreshInterval > 0 then
  local lastRefresh = tonumber(redis.call('HGET', stateKey, 'lastReservoirRefresh') or '0')
  if lastRefresh == 0 then
    -- State hash without a refresh stamp (pre-upgrade data, or legacy init):
    -- seed the clock to now WITHOUT touching the reservoir, so the current
    -- reservoir value survives its first full interval
    redis.call('HSET', stateKey, 'lastReservoirRefresh', now)
  elseif now - lastRefresh >= refreshInterval then
    redis.call('HSET', stateKey, 'reservoir', refreshAmount)
    redis.call('HSET', stateKey, 'lastReservoirRefresh', now)
    reservoir = refreshAmount
  end
end

-- Refuse a jobId that is still tracked as active: acquire/release accounting
-- must stay symmetric. A second acquire would HINCRBY running/currentWeight
-- while HSET/ZADD on :jobs merely overwrite the existing member, so the pair
-- of releases would only decrement once — permanently leaking a slot. By
-- returning early the stale entry also keeps its original start score, so
-- the heartbeat reaper reclaims it after staleJobTimeout and a retried job
-- with the same id can then proceed cleanly.
if redis.call('HEXISTS', stateKey .. ':jobs', jobId) == 1 then
  return {0, running, 0, 'duplicate'}
end

-- Check concurrency limit
if currentWeight + weight > maxConcurrent then
  return {0, running, 0, 'concurrency'}
end

-- Check reservoir
if reservoir ~= false and tonumber(reservoir) <= 0 then
  return {0, running, 0, 'reservoir'}
end

-- Check interval rate limit
if now - intervalStart >= interval then
  intervalStart = now
  intervalCount = 0
end

if intervalCount >= maxPerInterval then
  local waitTime = interval - (now - intervalStart)
  return {0, running, waitTime, 'interval'}
end

-- Check min time between jobs
local timeSinceLastJob = now - lastJobTime
if timeSinceLastJob < minTime then
  local waitTime = minTime - timeSinceLastJob
  return {0, running, waitTime, 'minTime'}
end

-- All checks passed - acquire slot
redis.call('HINCRBY', stateKey, 'running', 1)
redis.call('HINCRBY', stateKey, 'currentWeight', weight)
redis.call('HSET', stateKey, 'lastJobTime', now)
redis.call('HSET', stateKey, 'intervalStart', intervalStart)
redis.call('HINCRBY', stateKey, 'intervalCount', 1)

-- Decrement reservoir if set
if reservoir ~= false then
  redis.call('HINCRBY', stateKey, 'reservoir', -1)
end

-- Track active job (hash: id -> weight, zset: id scored by start time for reaping)
redis.call('HSET', stateKey .. ':jobs', jobId, weight)
redis.call('ZADD', stateKey .. ':jobs:started', now, jobId)

-- Set TTL on state (cleanup after inactivity)
redis.call('EXPIRE', stateKey, 3600)
redis.call('EXPIRE', stateKey .. ':jobs', 3600)
redis.call('EXPIRE', stateKey .. ':jobs:started', 3600)

return {1, running + 1, 0, 'ok'}
`;

/**
 * Release a slot after job completion
 * KEYS[1]: limiter state key
 * ARGV[1]: job weight
 * ARGV[2]: job id
 * ARGV[3]: success (1) or failure (0)
 */
export const RELEASE_SLOT = `
local stateKey = KEYS[1]
local weight = tonumber(ARGV[1])
local jobId = ARGV[2]
local success = tonumber(ARGV[3])

-- Remove from active jobs; only decrement counters if the job still held a
-- slot (it may have already been reaped as stale by HEARTBEAT)
local existed = redis.call('HDEL', stateKey .. ':jobs', jobId)
redis.call('ZREM', stateKey .. ':jobs:started', jobId)

local running = tonumber(redis.call('HGET', stateKey, 'running') or '0')
if existed == 1 then
  running = redis.call('HINCRBY', stateKey, 'running', -1)
  redis.call('HINCRBY', stateKey, 'currentWeight', -weight)
end

-- Update stats
if success == 1 then
  redis.call('HINCRBY', stateKey, 'done', 1)
else
  redis.call('HINCRBY', stateKey, 'failed', 1)
end

return running
`;

/**
 * Get current limiter state
 * KEYS[1]: limiter state key
 */
export const GET_STATE = `
local stateKey = KEYS[1]

local running = tonumber(redis.call('HGET', stateKey, 'running') or '0')
local currentWeight = tonumber(redis.call('HGET', stateKey, 'currentWeight') or '0')
local done = tonumber(redis.call('HGET', stateKey, 'done') or '0')
local failed = tonumber(redis.call('HGET', stateKey, 'failed') or '0')
local reservoir = redis.call('HGET', stateKey, 'reservoir')

if reservoir == false then
  reservoir = -1
else
  reservoir = tonumber(reservoir)
end

return {running, currentWeight, done, failed, reservoir}
`;

/**
 * Update reservoir value
 * KEYS[1]: limiter state key
 * ARGV[1]: new reservoir value
 */
export const UPDATE_RESERVOIR = `
local stateKey = KEYS[1]
local value = tonumber(ARGV[1])

redis.call('HSET', stateKey, 'reservoir', value)
redis.call('EXPIRE', stateKey, 3600)

return value
`;

/**
 * Increment reservoir value
 * KEYS[1]: limiter state key
 * ARGV[1]: amount to add
 */
export const INCREMENT_RESERVOIR = `
local stateKey = KEYS[1]
local amount = tonumber(ARGV[1])

local current = tonumber(redis.call('HGET', stateKey, 'reservoir') or '0')
local newValue = current + amount

redis.call('HSET', stateKey, 'reservoir', newValue)
redis.call('EXPIRE', stateKey, 3600)

return newValue
`;

/**
 * Initialize limiter state
 * KEYS[1]: limiter state key
 * ARGV[1]: reservoir (or -1 for null)
 * ARGV[2]: current timestamp (ms)
 */
export const INIT_STATE = `
local stateKey = KEYS[1]
local reservoir = tonumber(ARGV[1])
local now = tonumber(ARGV[2])

-- Only initialize if not exists
if redis.call('EXISTS', stateKey) == 0 then
  redis.call('HSET', stateKey, 'running', 0)
  redis.call('HSET', stateKey, 'currentWeight', 0)
  redis.call('HSET', stateKey, 'lastJobTime', 0)
  redis.call('HSET', stateKey, 'intervalStart', 0)
  redis.call('HSET', stateKey, 'intervalCount', 0)
  redis.call('HSET', stateKey, 'done', 0)
  redis.call('HSET', stateKey, 'failed', 0)

  if reservoir >= 0 then
    redis.call('HSET', stateKey, 'reservoir', reservoir)
    -- Stamp the refresh clock at creation time so the first lazy refresh
    -- happens one full interval later. Stamping 0 would make the very first
    -- acquire satisfy 'now - lastRefresh >= refreshInterval' and clobber the
    -- configured initial reservoir with reservoirRefreshAmount.
    redis.call('HSET', stateKey, 'lastReservoirRefresh', now)
  end

  redis.call('EXPIRE', stateKey, 3600)
end

return 1
`;

/**
 * Clear limiter state (for testing/reset)
 * KEYS[1]: limiter state key
 */
export const CLEAR_STATE = `
local stateKey = KEYS[1]

redis.call('DEL', stateKey)
redis.call('DEL', stateKey .. ':jobs')
redis.call('DEL', stateKey .. ':jobs:started')
redis.call('DEL', stateKey .. ':queue')

return 1
`;

/**
 * Heartbeat - extend TTL and reap stale jobs
 * Jobs started more than ARGV[2] ms ago are presumed dead (crashed process
 * that never released) and their running/currentWeight is reclaimed.
 * Returns: number of jobs reaped
 *
 * KEYS[1]: limiter state key
 * ARGV[1]: current timestamp
 * ARGV[2]: stale job timeout (ms)
 */
export const HEARTBEAT = `
local stateKey = KEYS[1]
local now = tonumber(ARGV[1])
local timeout = tonumber(ARGV[2])
local jobsKey = stateKey .. ':jobs'
local startedKey = stateKey .. ':jobs:started'

-- Extend TTL
redis.call('EXPIRE', stateKey, 3600)
redis.call('EXPIRE', jobsKey, 3600)
redis.call('EXPIRE', startedKey, 3600)

-- Reap stale jobs
local reaped = 0
local stale = redis.call('ZRANGEBYSCORE', startedKey, '-inf', now - timeout)
for _, jobId in ipairs(stale) do
  local weight = tonumber(redis.call('HGET', jobsKey, jobId) or '0')
  redis.call('HINCRBY', stateKey, 'running', -1)
  redis.call('HINCRBY', stateKey, 'currentWeight', -weight)
  redis.call('HDEL', jobsKey, jobId)
  redis.call('ZREM', startedKey, jobId)
  reaped = reaped + 1
end

if reaped > 0 then
  redis.call('HINCRBY', stateKey, 'reaped', reaped)

  -- Clamp counters at zero (defensive against double-decrement)
  if tonumber(redis.call('HGET', stateKey, 'running') or '0') < 0 then
    redis.call('HSET', stateKey, 'running', 0)
  end
  if tonumber(redis.call('HGET', stateKey, 'currentWeight') or '0') < 0 then
    redis.call('HSET', stateKey, 'currentWeight', 0)
  end
end

return reaped
`;

