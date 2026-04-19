import { describe, expect, it, vi } from "vitest";

import { runWithEvent } from "../core/event-context.js";
import { instrumentPrisma } from "./prisma.js";

// Mock Prisma that satisfies the narrow interface. Records every call so
// we can assert on the SET-first, user-query-second ordering. `mock` is
// exposed separately so tests can read `.mock.calls` without needing the
// function type to match the interface.
type FakePrisma = {
  $executeRawUnsafe: (query: string) => Promise<unknown>;
  $extends: (def: unknown) => unknown;
};

interface FakeHarness {
  instance: FakePrisma;
  mock: ReturnType<typeof vi.fn>;
}

function fakePrisma(): FakeHarness {
  const mock = vi.fn(async (_q: string) => 0 as unknown);
  let handler: ((ctx: unknown) => unknown) | null = null;
  const instance: FakePrisma = {
    $executeRawUnsafe: mock as unknown as (q: string) => Promise<unknown>,
    $extends(def) {
      const d = def as {
        query?: { $allOperations?: (ctx: unknown) => unknown };
      };
      if (d.query?.$allOperations) {
        handler = d.query.$allOperations;
      }
      return {
        ...instance,
        runOperation: (args: unknown) =>
          handler!({
            args,
            query: async (a: unknown) => ({ rows: [{ ran: true, with: a }] }),
          }),
      };
    },
  };
  return { instance, mock };
}

describe("instrumentPrisma", () => {
  it("prepends SET application_name = clv:<eventId> before each operation", async () => {
    const { instance, mock } = fakePrisma();
    const wrapped = instrumentPrisma(instance as unknown as Parameters<typeof instrumentPrisma>[0]) as FakePrisma & {
      runOperation: (a: unknown) => Promise<unknown>;
    };

    const result = await runWithEvent({ eventId: "ev_p1" }, async () => {
      return await wrapped.runOperation({ model: "User", where: { id: 1 } });
    });

    expect(mock).toHaveBeenCalledWith("SET application_name = 'clv:ev_p1'");
    expect(result).toEqual({
      rows: [{ ran: true, with: { model: "User", where: { id: 1 } } }],
    });
  });

  it("composes replayId into the application_name", async () => {
    const { instance, mock } = fakePrisma();
    const wrapped = instrumentPrisma(instance as unknown as Parameters<typeof instrumentPrisma>[0], { replayId: "rep_7" }) as FakePrisma & {
      runOperation: (a: unknown) => Promise<unknown>;
    };

    await runWithEvent({ eventId: "ev_p2" }, async () => {
      await wrapped.runOperation({});
    });

    expect(mock).toHaveBeenCalledWith("SET application_name = 'clv:rep_7:ev_p2'");
  });

  it("skips the SET when there's no active event scope", async () => {
    const { instance, mock } = fakePrisma();
    const wrapped = instrumentPrisma(instance as unknown as Parameters<typeof instrumentPrisma>[0]) as FakePrisma & {
      runOperation: (a: unknown) => Promise<unknown>;
    };

    await wrapped.runOperation({});

    expect(mock).not.toHaveBeenCalled();
  });

  it("swallows SET errors and still runs the user operation", async () => {
    const { instance, mock } = fakePrisma();
    mock.mockRejectedValueOnce(new Error("boom"));
    let captured: unknown = null;
    const wrapped = instrumentPrisma(instance as unknown as Parameters<typeof instrumentPrisma>[0], {
      onError: (e) => (captured = e),
    }) as FakePrisma & { runOperation: (a: unknown) => Promise<unknown> };

    const result = await runWithEvent({ eventId: "ev_p3" }, async () => {
      return await wrapped.runOperation({ id: 7 });
    });

    expect((captured as Error | null)?.message).toBe("boom");
    expect(result).toEqual({ rows: [{ ran: true, with: { id: 7 } }] });
  });

  it("truncates oversized application_name to 63 chars (pg limit)", async () => {
    const { instance, mock } = fakePrisma();
    const wrapped = instrumentPrisma(instance as unknown as Parameters<typeof instrumentPrisma>[0], {
      replayId: "rep_with_a_very_very_long_name_that_pushes_past_the_pg_cap",
    }) as FakePrisma & { runOperation: (a: unknown) => Promise<unknown> };

    await runWithEvent({ eventId: "ev_with_long_enough_suffix" }, async () => {
      await wrapped.runOperation({});
    });

    const call = mock.mock.calls[0]![0] as string;
    const appName = call.replace(/^SET application_name = '/, "").replace(/'$/, "");
    expect(appName.length).toBeLessThanOrEqual(63);
  });
});
