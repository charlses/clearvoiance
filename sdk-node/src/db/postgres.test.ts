import { describe, expect, it } from "vitest";

import { parseClvAppName } from "./postgres.js";

describe("parseClvAppName", () => {
  it("parses clv:<eventId> (no replay)", () => {
    expect(parseClvAppName("clv:ev_abc123")).toEqual({ eventId: "ev_abc123" });
  });
  it("parses clv:<replayId>:<eventId>", () => {
    expect(parseClvAppName("clv:rep_7:ev_abc123")).toEqual({
      replayId: "rep_7",
      eventId: "ev_abc123",
    });
  });
  it("returns null for non-clv names", () => {
    expect(parseClvAppName("postgres")).toBeNull();
    expect(parseClvAppName("")).toBeNull();
    expect(parseClvAppName("clv:")).toBeNull();
  });
  it("honors a custom prefix", () => {
    expect(parseClvAppName("obs:ev_1", "obs:")).toEqual({ eventId: "ev_1" });
  });
});
