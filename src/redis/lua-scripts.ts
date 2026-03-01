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

-- Get current state
local running = tonumber(redis.call('HGET', stateKey, 'running') or '0')
local currentWeight = tonumber(redis.call('HGET', stateKey, 'currentWeight') or '0')
local lastJobTime = tonumber(redis.call('HGET', stateKey, 'lastJobTime') or '0')
local intervalStart = tonumber(redis.call('HGET', stateKey, 'intervalStart') or '0')
local intervalCount = tonumber(redis.call('HGET', stateKey, 'intervalCount') or '0')
local reservoir = redis.call('HGET', stateKey, 'reservoir')

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

-- Track active job
redis.call('HSET', stateKey .. ':jobs', jobId, weight)

-- Set TTL on state (cleanup after inactivity)
redis.call('EXPIRE', stateKey, 3600)
redis.call('EXPIRE', stateKey .. ':jobs', 3600)

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

-- Decrement running count
local running = redis.call('HINCRBY', stateKey, 'running', -1)
redis.call('HINCRBY', stateKey, 'currentWeight', -weight)

-- Update stats
if success == 1 then
  redis.call('HINCRBY', stateKey, 'done', 1)
else
  redis.call('HINCRBY', stateKey, 'failed', 1)
end

-- Remove from active jobs
redis.call('HDEL', stateKey .. ':jobs', jobId)

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
 */
export const INIT_STATE = `
local stateKey = KEYS[1]
local reservoir = tonumber(ARGV[1])

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
redis.call('DEL', stateKey .. ':queue')

return 1
`;

/**
 * Heartbeat - extend TTL and clean up stale jobs
 * KEYS[1]: limiter state key
 * ARGV[1]: current timestamp
 * ARGV[2]: job timeout (ms)
 */
export const HEARTBEAT = `
local stateKey = KEYS[1]
local now = tonumber(ARGV[1])
local timeout = tonumber(ARGV[2])

-- Extend TTL
redis.call('EXPIRE', stateKey, 3600)
redis.call('EXPIRE', stateKey .. ':jobs', 3600)

-- Could add stale job cleanup here if needed

return redis.call('HGET', stateKey, 'running') or '0'
`;

