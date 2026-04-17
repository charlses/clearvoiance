import { describe, expect, it } from "vitest";
import { currentEventId, newEventId, runWithEvent } from "./event-context.js";

describe("newEventId", () => {
  it("produces unique ids and the ev_ prefix", () => {
    const a = newEventId();
    const b = newEventId();
    expect(a).toMatch(/^ev_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("ids from later calls sort >= earlier ones (timestamp prefix is monotonic)", () => {
    const a = newEventId();
    const b = newEventId();
    expect(b.slice(3, 19) >= a.slice(3, 19)).toBe(true);
  });
});

describe("event context", () => {
  it("currentEventId returns the id inside runWithEvent", () => {
    expect(currentEventId()).toBeUndefined();
    runWithEvent({ eventId: "ev_test" }, () => {
      expect(currentEventId()).toBe("ev_test");
    });
    expect(currentEventId()).toBeUndefined();
  });

  it("nested contexts shadow parents", () => {
    runWithEvent({ eventId: "outer" }, () => {
      expect(currentEventId()).toBe("outer");
      runWithEvent({ eventId: "inner" }, () => {
        expect(currentEventId()).toBe("inner");
      });
      expect(currentEventId()).toBe("outer");
    });
  });
});
