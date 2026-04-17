/**
 * In-memory mock store. On hermetic activation the SDK pulls a mock pack from
 * the engine (one entry per captured outbound in the source session) and
 * indexes it here. When the SUT makes an outbound under replay, the intercept
 * layer looks up `(currentEventId, signature)` → MockEntry → replayed response.
 *
 * Duplicate (eventId, signature) pairs are allowed: captures may have
 * fired the same outbound multiple times inside a single inbound scope.
 * `take()` cycles through them in FIFO order so repeated outbounds get
 * distinct responses (mirrors the capture sequence).
 */

export interface MockEntry {
  /** caused_by_event_id from the captured OutboundEvent. */
  eventId: string;
  /** Canonical signature (see outbound/signature.ts). */
  signature: string;
  status: number;
  responseHeaders: Record<string, string[]>;
  responseBody: Buffer;
  responseContentType: string;
}

interface Bucket {
  entries: MockEntry[];
  /** Next entry to hand out; rolls back to 0 once exhausted so long replays still serve something. */
  cursor: number;
}

export class MockStore {
  private readonly buckets = new Map<string, Bucket>();
  private _size = 0;

  /** Returns the number of entries in the store. */
  get size(): number {
    return this._size;
  }

  /** Adds a mock entry. Later `take(eventId, signature)` will return it. */
  add(entry: MockEntry): void {
    const key = keyOf(entry.eventId, entry.signature);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { entries: [], cursor: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.entries.push(entry);
    this._size += 1;
  }

  /**
   * Looks up the next mock entry for `(eventId, signature)`. Cycles through
   * duplicates in FIFO order; resets cursor after all entries are consumed so
   * long-running replays (e.g. poll loops) still find a mock.
   */
  take(eventId: string, signature: string): MockEntry | undefined {
    const bucket = this.buckets.get(keyOf(eventId, signature));
    if (!bucket || bucket.entries.length === 0) return undefined;

    const idx = bucket.cursor % bucket.entries.length;
    bucket.cursor += 1;
    return bucket.entries[idx];
  }

  /** Total number of distinct (eventId, signature) pairs indexed. */
  distinctKeys(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
    this._size = 0;
  }
}

function keyOf(eventId: string, signature: string): string {
  return `${eventId}|${signature}`;
}
