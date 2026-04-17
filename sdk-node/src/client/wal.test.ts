import { mkdtemp, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../generated/clearvoiance/v1/event.js";
import { WAL } from "./wal.js";

function fakeEvent(id: string): PbEvent {
  return {
    id,
    sessionId: "sess_test",
    timestampNs: 1_000n,
    offsetNs: 0n,
    adapter: "test",
    sdkVersion: "test-0.0.0",
    metadata: {},
    redactionsApplied: [],
  };
}

describe("WAL", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wal-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a batch through disk", async () => {
    const wal = new WAL({ dir: root, sessionId: "sess_a" });
    const events = [fakeEvent("e1"), fakeEvent("e2")];

    const res = await wal.append(1n, events);
    expect(res.persisted).toBe(true);

    const entries = await wal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.batchId).toBe(1n);
    expect(entries[0]!.events).toHaveLength(2);
    expect(entries[0]!.events[0]!.id).toBe("e1");
  });

  it("list() returns entries sorted by batch id ascending", async () => {
    const wal = new WAL({ dir: root, sessionId: "s" });
    // Append out of order; verify list() returns ordered.
    await wal.append(10n, [fakeEvent("a")]);
    await wal.append(2n, [fakeEvent("b")]);
    await wal.append(123n, [fakeEvent("c")]);

    const entries = await wal.list();
    expect(entries.map((e) => e.batchId)).toEqual([2n, 10n, 123n]);
  });

  it("remove() deletes the file and updates usedBytes", async () => {
    const wal = new WAL({ dir: root, sessionId: "s" });
    await wal.append(1n, [fakeEvent("x")]);
    const [entry] = await wal.list();
    expect(entry).toBeDefined();

    const beforeBytes = wal.usedBytes;
    expect(beforeBytes).toBeGreaterThan(0);

    await wal.remove(entry!);
    const left = await readdir(path.join(root, "s"));
    expect(left).toEqual([]);
    expect(wal.usedBytes).toBe(0);
  });

  it("refuses to append when capacity would be exceeded", async () => {
    const wal = new WAL({ dir: root, sessionId: "s", maxBytes: 10 });
    const big = [fakeEvent("x".repeat(100))];

    const res = await wal.append(1n, big);
    expect(res.persisted).toBe(false);
    if (!res.persisted) expect(res.reason).toBe("capacity");
  });

  it("skips .tmp partial files", async () => {
    const wal = new WAL({ dir: root, sessionId: "s" });
    await wal.append(1n, [fakeEvent("real")]);

    // Simulate a crashed writer by dropping a .tmp file.
    const tmp = path.join(root, "s", "00000000000000000042.pb.tmp");
    await (await import("node:fs/promises")).writeFile(tmp, Buffer.from([0, 1, 2]));

    const entries = await wal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.batchId).toBe(1n);
  });

  it("recovers the byte count on init() across process restarts", async () => {
    const wal = new WAL({ dir: root, sessionId: "s" });
    await wal.append(1n, [fakeEvent("one")]);
    const used = wal.usedBytes;

    // Second WAL instance pointed at the same dir should see the same bytes.
    const wal2 = new WAL({ dir: root, sessionId: "s" });
    await wal2.init();
    expect(wal2.usedBytes).toBe(used);

    const entries = await wal2.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.events[0]!.id).toBe("one");
  });
});
