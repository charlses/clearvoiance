/**
 * Local write-ahead log for captured event batches.
 *
 * Used as the offline path: when the engine is unreachable, the Client writes
 * batches to disk under `{dir}/{session_id}/{batch_id}.pb` and later drains
 * them back to the engine when the connection restores.
 *
 * File format: one EventBatch protobuf per file, raw (no length prefix — the
 * file boundary is the message boundary). A `.tmp` extension is used for
 * in-progress writes so partial files are never drained.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { EventBatch } from "../generated/clearvoiance/v1/capture.js";
import type { Event as PbEvent } from "../generated/clearvoiance/v1/event.js";

export interface WALOptions {
  /** Root directory. Default: ${XDG_STATE_HOME:-$HOME/.local/state}/clearvoiance/wal */
  dir: string;
  sessionId: string;
  /**
   * Hard cap on total WAL bytes before append() starts dropping batches.
   * Default 1 GB.
   */
  maxBytes?: number;
}

export interface WALEntry {
  batchId: bigint;
  events: PbEvent[];
  /** Absolute path of the file — caller passes this back to `remove()`. */
  filePath: string;
  sizeBytes: number;
}

export class WAL {
  readonly dir: string;
  readonly sessionDir: string;
  private readonly maxBytes: number;
  private currentBytes = 0;
  private initialized = false;

  constructor(opts: WALOptions) {
    this.dir = opts.dir;
    this.sessionDir = path.join(this.dir, opts.sessionId);
    this.maxBytes = opts.maxBytes ?? 1 * 1024 * 1024 * 1024;
  }

  /** Creates the session dir + scans current byte usage. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.sessionDir, { recursive: true });
    const files = await this.list();
    this.currentBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    this.initialized = true;
  }

  /**
   * Writes a batch to `{batchId}.pb`. Returns `{ persisted: true }` on
   * success or `{ persisted: false, reason: "capacity" }` when the WAL is full.
   */
  async append(
    batchId: bigint,
    events: PbEvent[],
  ): Promise<{ persisted: true; path: string } | { persisted: false; reason: string }> {
    await this.init();

    const bytes = EventBatch.encode({ events, batchId }).finish();
    if (this.currentBytes + bytes.length > this.maxBytes) {
      return { persisted: false, reason: "capacity" };
    }

    const filename = `${formatBatchId(batchId)}.pb`;
    const finalPath = path.join(this.sessionDir, filename);
    const tmpPath = `${finalPath}.tmp`;

    await fs.writeFile(tmpPath, bytes);
    await fs.rename(tmpPath, finalPath);
    this.currentBytes += bytes.length;

    return { persisted: true, path: finalPath };
  }

  /**
   * Lists non-in-progress WAL files in batchId order. Cheap to call; used by
   * the drain loop and by `init()` to compute currentBytes.
   */
  async list(): Promise<WALEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.sessionDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const entries: Array<{ name: string; batchId: bigint }> = [];
    for (const n of names) {
      if (!n.endsWith(".pb")) continue; // skip .tmp partial writes
      const base = n.slice(0, -".pb".length);
      const batchId = parseBatchId(base);
      if (batchId !== null) entries.push({ name: n, batchId });
    }
    entries.sort((a, b) => (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0));

    const out: WALEntry[] = [];
    for (const { name, batchId } of entries) {
      const filePath = path.join(this.sessionDir, name);
      const bytes = await fs.readFile(filePath);
      const decoded = EventBatch.decode(bytes);
      out.push({ batchId, events: decoded.events, filePath, sizeBytes: bytes.length });
    }
    return out;
  }

  /** Deletes a drained file and subtracts it from currentBytes. */
  async remove(entry: WALEntry): Promise<void> {
    try {
      await fs.unlink(entry.filePath);
      this.currentBytes = Math.max(0, this.currentBytes - entry.sizeBytes);
    } catch (err) {
      // Already gone — race with another drainer or a cleanup. Ignore.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** Currently-used bytes (approximate; updated on append/remove). */
  get usedBytes(): number {
    return this.currentBytes;
  }
}

function formatBatchId(batchId: bigint): string {
  // Zero-pad to 20 digits so lexicographic sort matches numeric sort.
  return batchId.toString().padStart(20, "0");
}

function parseBatchId(s: string): bigint | null {
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
