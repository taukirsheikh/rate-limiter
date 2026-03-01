import type { EventListener, RateLimiterEvents } from './types.js';

/**
 * Type-safe event emitter for the rate limiter
 */
export class TypedEventEmitter {
  private listeners = new Map<keyof RateLimiterEvents, Set<EventListener<unknown>>>();

  /**
   * Subscribe to an event
   */
  on<K extends keyof RateLimiterEvents>(
    event: K,
    listener: EventListener<RateLimiterEvents[K]>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<unknown>);

    // Return unsubscribe function
    return () => this.off(event, listener);
  }

  /**
   * Subscribe to an event once
   */
  once<K extends keyof RateLimiterEvents>(
    event: K,
    listener: EventListener<RateLimiterEvents[K]>
  ): () => void {
    const wrapper = ((data: RateLimiterEvents[K]) => {
      this.off(event, wrapper);
      listener(data);
    }) as EventListener<RateLimiterEvents[K]>;

    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends keyof RateLimiterEvents>(
    event: K,
    listener: EventListener<RateLimiterEvents[K]>
  ): void {
    this.listeners.get(event)?.delete(listener as EventListener<unknown>);
  }

  /**
   * Emit an event to all listeners
   */
  protected emit<K extends keyof RateLimiterEvents>(
    event: K,
    data: RateLimiterEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        try {
          listener(data);
        } catch (error) {
          // Don't let listener errors break the emitter
          console.error(`Error in event listener for "${String(event)}":`, error);
        }
      }
    }
  }

  /**
   * Remove all listeners for an event (or all events)
   */
  removeAllListeners(event?: keyof RateLimiterEvents): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Get listener count for an event
   */
  listenerCount(event: keyof RateLimiterEvents): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

