import type { Job } from './types.js';

/**
 * A priority queue implementation using a binary heap
 * Lower priority values = higher priority (executed first)
 */
export class PriorityQueue<T extends Job = Job> {
  private heap: T[] = [];

  /**
   * Number of items in the queue
   */
  get size(): number {
    return this.heap.length;
  }

  /**
   * Whether the queue is empty
   */
  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Add an item to the queue
   */
  enqueue(item: T): number {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
    return this.heap.length;
  }

  /**
   * Remove and return the highest priority item
   */
  dequeue(): T | undefined {
    if (this.heap.length === 0) return undefined;

    const top = this.heap[0];
    const bottom = this.heap.pop();

    if (this.heap.length > 0 && bottom !== undefined) {
      this.heap[0] = bottom;
      this.bubbleDown(0);
    }

    return top;
  }

  /**
   * Peek at the highest priority item without removing
   */
  peek(): T | undefined {
    return this.heap[0];
  }

  /**
   * Remove a specific item by ID
   */
  removeById(id: string): T | undefined {
    const index = this.heap.findIndex((item) => item.id === id);
    if (index === -1) return undefined;

    const item = this.heap[index];
    const last = this.heap.pop();

    if (index < this.heap.length && last !== undefined) {
      this.heap[index] = last;
      // Re-heapify: might need to go up or down
      this.bubbleUp(index);
      this.bubbleDown(index);
    }

    return item;
  }

  /**
   * Get all items (for inspection, not modification)
   */
  toArray(): readonly T[] {
    return [...this.heap].sort((a, b) => this.compare(a, b));
  }

  /**
   * Clear all items
   */
  clear(): void {
    this.heap = [];
  }

  /**
   * Check if an item exists by ID
   */
  has(id: string): boolean {
    return this.heap.some((item) => item.id === id);
  }

  /**
   * Get item by ID
   */
  getById(id: string): T | undefined {
    return this.heap.find((item) => item.id === id);
  }

  /**
   * Compare two jobs for priority ordering
   * Returns negative if a should come before b
   */
  private compare(a: T, b: T): number {
    // First compare by priority (lower = higher priority)
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // Then by queue time (FIFO within same priority)
    return a.queuedAt - b.queuedAt;
  }

  /**
   * Move item up the heap until in correct position
   */
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[index], this.heap[parentIndex]) >= 0) {
        break;
      }
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  /**
   * Move item down the heap until in correct position
   */
  private bubbleDown(index: number): void {
    const length = this.heap.length;

    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (
        leftChild < length &&
        this.compare(this.heap[leftChild], this.heap[smallest]) < 0
      ) {
        smallest = leftChild;
      }

      if (
        rightChild < length &&
        this.compare(this.heap[rightChild], this.heap[smallest]) < 0
      ) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      this.swap(index, smallest);
      index = smallest;
    }
  }

  /**
   * Swap two items in the heap
   */
  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }
}

