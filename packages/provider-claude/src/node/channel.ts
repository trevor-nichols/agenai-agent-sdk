// ------------------------------------------------------------------------------------------------
//                channel.ts - One bounded single-consumer queue for a turn's ordered observations
// ------------------------------------------------------------------------------------------------

export const CHANNEL_CAPACITY = 1_024;

/**
 * Bounded data with a separate wake-up, so the owner can signal control state that must never be
 * dropped even after the data bound has overflowed.
 */
export class TurnChannel<Item> {
  private readonly items: Item[] = [];
  private waiting: (() => void) | undefined;
  private overflowed = false;

  /** Returns false once the bound is exceeded; the owner then fails the turn instead of buffering more. */
  push(item: Item): boolean {
    if (this.overflowed) return false;
    if (this.items.length >= CHANNEL_CAPACITY) {
      this.overflowed = true;
      this.wake();
      return false;
    }
    this.items.push(item);
    this.wake();
    return true;
  }

  get overflow(): boolean { return this.overflowed; }

  take(): Item | undefined { return this.items.shift(); }

  /** Wakes the consumer so it re-reads both the queue and the owner's control state. */
  wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }

  /** Resolves on the next push or wake; the consumer checks every source before waiting. */
  wait(): Promise<void> {
    if (this.waiting) throw new Error('A turn channel has exactly one consumer.');
    return new Promise((resolve) => { this.waiting = resolve; });
  }
}
