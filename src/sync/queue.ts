/**
 * Strict FIFO Async Task Queue and Mutex for guaranteed sequential execution.
 * Prevents race conditions and guarantees ordering for file sync operations.
 */

export class Mutex {
  private current: Promise<void> = Promise.resolve();

  async acquire<T>(task: () => Promise<T>): Promise<T> {
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.current;
    this.current = next;

    await previous;
    try {
      return await task();
    } finally {
      release!();
    }
  }

  isLocked(): boolean {
    // Check if the current promise has resolved
    let locked = true;
    Promise.race([
      this.current.then(() => false),
      Promise.resolve(true),
    ]).then(val => {
      locked = val;
    });
    return locked;
  }
}

export type QueueTask<T> = () => Promise<T>;

export class FifoQueue {
  private queue: Array<() => Promise<void>> = [];
  private isProcessing: boolean = false;

  /**
   * Enqueue a task to be executed strictly in FIFO order.
   */
  enqueue<T>(task: QueueTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing) return;
    if (this.queue.length === 0) return;

    this.isProcessing = true;
    const task = this.queue.shift();

    if (task) {
      try {
        await task();
      } catch (err) {
        console.error("Queue task execution error:", err);
      } finally {
        this.isProcessing = false;
        this.processNext();
      }
    } else {
      this.isProcessing = false;
    }
  }

  get length(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}

/**
 * Debounce buffer by key (e.g. file path).
 * Consolidates rapid successive modifications to the same file before triggering execution.
 */
export class DebounceManager {
  private timers: Map<string, number> = new Map();

  debounce(key: string, delayMs: number, fn: () => void): void {
    if (this.timers.has(key)) {
      window.clearTimeout(this.timers.get(key));
    }
    const timer = window.setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, delayMs);
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    if (this.timers.has(key)) {
      window.clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
  }
}
