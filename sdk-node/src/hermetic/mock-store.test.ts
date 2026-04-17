import { describe, expect, it } from "vitest";

import { MockStore, type MockEntry } from "./mock-store.js";

function mock(eventId: string, signature: string, body: string, status = 200): MockEntry {
  return {
    eventId,
    signature,
    status,
    responseHeaders: {},
    responseBody: Buffer.from(body),
    responseContentType: "text/plain",
  };
}

describe("MockStore", () => {
  it("returns undefined for unknown keys", () => {
    const s = new MockStore();
    expect(s.take("ev_x", "sig_x")).toBeUndefined();
  });

  it("returns a single entry by (eventId, signature)", () => {
    const s = new MockStore();
    s.add(mock("ev_1", "sig_a", "hello"));
    const got = s.take("ev_1", "sig_a")!;
    expect(got.responseBody.toString()).toBe("hello");
  });

  it("cycles FIFO through duplicate entries, then wraps", () => {
    const s = new MockStore();
    s.add(mock("ev_1", "sig_a", "one"));
    s.add(mock("ev_1", "sig_a", "two"));
    s.add(mock("ev_1", "sig_a", "three"));

    expect(s.take("ev_1", "sig_a")!.responseBody.toString()).toBe("one");
    expect(s.take("ev_1", "sig_a")!.responseBody.toString()).toBe("two");
    expect(s.take("ev_1", "sig_a")!.responseBody.toString()).toBe("three");
    // Wraps rather than returning undefined.
    expect(s.take("ev_1", "sig_a")!.responseBody.toString()).toBe("one");
  });

  it("keeps entries scoped to their own (eventId, signature) key", () => {
    const s = new MockStore();
    s.add(mock("ev_1", "sig_a", "A"));
    s.add(mock("ev_2", "sig_a", "B"));
    s.add(mock("ev_1", "sig_b", "C"));

    expect(s.take("ev_1", "sig_a")!.responseBody.toString()).toBe("A");
    expect(s.take("ev_2", "sig_a")!.responseBody.toString()).toBe("B");
    expect(s.take("ev_1", "sig_b")!.responseBody.toString()).toBe("C");
    expect(s.size).toBe(3);
    expect(s.distinctKeys()).toBe(3);
  });
});
