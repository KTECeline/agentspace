import { internalError, warnLimited } from "./log.js";

/** Fixed-size FIFO; pushing when full drops the oldest item. O(1) everything. */
export class Ring<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private size = 0;
  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }
  get length() {
    return this.size;
  }
  /** Returns true if an old item was dropped to make room. */
  push(item: T): boolean {
    const tail = (this.head + this.size) % this.capacity;
    this.buf[tail] = item;
    if (this.size < this.capacity) {
      this.size += 1;
      return false;
    }
    this.head = (this.head + 1) % this.capacity; // overwrote the oldest
    return true;
  }
  shift(n: number): T[] {
    const out: T[] = [];
    while (out.length < n && this.size > 0) {
      out.push(this.buf[this.head] as T);
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.size -= 1;
    }
    return out;
  }
  /** Put items back at the front (oldest first), dropping from the batch if there's no room. */
  unshift(items: T[]): number {
    const room = this.capacity - this.size;
    const keep = items.slice(Math.max(0, items.length - room));
    for (let i = keep.length - 1; i >= 0; i--) {
      this.head = (this.head - 1 + this.capacity) % this.capacity;
      this.buf[this.head] = keep[i];
      this.size += 1;
    }
    return items.length - keep.length;
  }
}

export interface TransportOptions {
  endpoint: string;
  apiKey?: string;
  maxQueue: number;
  maxBatch: number;
  flushIntervalMs: number;
  timeoutMs: number;
  /** Called with the run controls (paused / cancelled) the collector returns on ingest. */
  onControls?: (controls: Record<string, string>) => void;
}

const MAX_BACKOFF_MS = 10_000;

/**
 * Batches events and POSTs them with fetch. put() is O(1) and synchronous; sending is async and
 * never throws. If the collector is unreachable, events are kept (bounded, oldest dropped
 * first) and retried with exponential backoff.
 */
export class Transport {
  readonly queue: Ring<object>;
  sent = 0;
  dropped = 0;
  rejected = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | null = null;
  private backoffMs = 0;
  private downSince: number | null = null;
  private closed = false;
  private readonly headers: Record<string, string>;

  constructor(private opts: TransportOptions) {
    this.queue = new Ring(opts.maxQueue);
    this.headers = { "content-type": "application/json", "user-agent": "agentspace-ts" };
    if (opts.apiKey) this.headers.authorization = `Bearer ${opts.apiKey}`;
  }

  get pending(): number {
    return this.queue.length;
  }

  get isDown(): boolean {
    return this.downSince !== null;
  }

  put(event: object): void {
    if (this.closed) return;
    if (this.queue.push(event)) {
      this.dropped += 1;
      warnLimited("queue-full", `event buffer full (${this.opts.maxQueue} events), dropping oldest events. Is the collector at ${this.opts.endpoint} running?`);
    }
    if (this.queue.length >= this.opts.maxBatch && !this.backoffMs) this.schedule(0);
    else this.schedule(this.opts.flushIntervalMs);
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined && delay > 0) return; // already scheduled
    if (this.timer !== undefined) clearTimeout(this.timer);
    const wait = this.backoffMs || delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, wait);
    // Never keep the host process alive just to send telemetry.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private drain(): Promise<void> {
    if (this.sending) return this.sending;
    // Nothing to send: return now. (Otherwise the async body below would finish synchronously,
    // clearing `sending` before it's assigned, and leave a stale promise that blocks all sends.)
    if (this.queue.length === 0) return Promise.resolve();
    this.sending = (async () => {
      try {
        while (this.queue.length > 0) {
          const batch = this.queue.shift(this.opts.maxBatch);
          const ok = await this.send(batch);
          if (!ok) {
            this.dropped += this.queue.unshift(batch);
            this.backoffMs = Math.min(MAX_BACKOFF_MS, (this.backoffMs || 250) * 2);
            break;
          }
          this.backoffMs = 0;
        }
      } catch (err) {
        internalError("transport", err);
      } finally {
        this.sending = null;
        if (this.queue.length > 0 && !this.closed) this.schedule(this.opts.flushIntervalMs);
      }
    })();
    return this.sending;
  }

  /** Returns false when the batch should be retried later. */
  private async send(batch: object[]): Promise<boolean> {
    let body: string;
    try {
      body = JSON.stringify({ events: batch }, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    } catch (err) {
      internalError("serialize", err);
      this.rejected += batch.length;
      return true; // can't ever send this batch
    }
    try {
      const res = await fetch(this.opts.endpoint, { method: "POST", headers: this.headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs) });
      if (res.ok) {
        this.markUp();
        let rejected = 0;
        try {
          const out = (await res.json()) as { rejected?: number; controls?: Record<string, string> };
          rejected = Number(out.rejected ?? 0);
          if (out.controls && this.opts.onControls) this.opts.onControls(out.controls);
        } catch {
          // ignore
        }
        this.rejected += rejected;
        this.sent += batch.length - rejected;
        if (rejected) warnLimited("partial-reject", `collector rejected ${rejected} of ${batch.length} events (schema mismatch?)`);
        return true;
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        this.markUp();
        this.rejected += batch.length;
        warnLimited("http-4xx", `collector rejected ${batch.length} events (HTTP ${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
        return true;
      }
      this.markDown(`HTTP ${res.status}`);
      return false;
    } catch (err) {
      this.markDown(String(err));
      return false;
    }
  }

  private markDown(why: string): void {
    if (this.downSince === null) {
      this.downSince = Date.now();
      console.warn(`agentspace: collector at ${this.opts.endpoint} unreachable (${why}). Buffering up to ${this.opts.maxQueue} events; your app keeps running normally.`);
    }
  }

  private markUp(): void {
    this.downSince = null;
  }

  /** Resolves true once everything queued has been sent; false on timeout or collector down. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.queue.length === 0 && !this.sending) return true;
      if (this.isDown) return false;
      await Promise.race([this.drain(), sleep(Math.max(1, deadline - Date.now()))]);
    }
    return this.queue.length === 0 && !this.sending;
  }

  async shutdown(timeoutMs = 2000): Promise<void> {
    await this.flush(timeoutMs);
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
