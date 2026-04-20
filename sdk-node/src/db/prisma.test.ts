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
        runOperation: (
          args: unknown,
          meta?: { model?: string; operation?: string; delayMs?: number },
        ) =>
          handler!({
            model: meta?.model,
            operation: meta?.operation,
            args,
            query: async (a: unknown) => {
              if (meta?.delayMs) {
                await new Promise((r) => setTimeout(r, meta.delayMs));
              }
              return { rows: [{ ran: true, with: a }] };
            },
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

  it("emits a DbObservationEvent per operation when emit.client is set", async () => {
    const { instance } = fakePrisma();
    const sent: unknown[] = [];
    const client = {
      sendBatch: async (events: unknown[]): Promise<void> => {
        sent.push(...events);
      },
    };
    const wrapped = instrumentPrisma(
      instance as unknown as Parameters<typeof instrumentPrisma>[0],
      { emit: { client, slowThresholdMs: 0 } },
    ) as FakePrisma & {
      runOperation: (
        a: unknown,
        meta?: { model?: string; operation?: string; delayMs?: number },
      ) => Promise<unknown>;
    };

    await runWithEvent({ eventId: "ev_pr_emit" }, async () => {
      await wrapped.runOperation(
        { where: { id: 42 } },
        { model: "User", operation: "findUnique", delayMs: 2 },
      );
    });

    expect(sent.length).toBe(1);
    const event = sent[0] as {
      adapter: string;
      db: { causedByEventId: string; queryFingerprint: string };
      metadata: Record<string, string>;
    };
    expect(event.adapter).toBe("db.prisma");
    expect(event.db.causedByEventId).toBe("ev_pr_emit");
    expect(event.db.queryFingerprint).toBe("User.findUnique");
    expect(event.metadata.prisma_op).toBe("findUnique");
    expect(event.metadata.prisma_model).toBe("User");
  });

  it("drops emitted observations below slowThresholdMs", async () => {
    const { instance } = fakePrisma();
    const sent: unknown[] = [];
    const client = {
      sendBatch: async (events: unknown[]): Promise<void> => {
        sent.push(...events);
      },
    };
    const wrapped = instrumentPrisma(
      instance as unknown as Parameters<typeof instrumentPrisma>[0],
      { emit: { client, slowThresholdMs: 1000 } },
    ) as FakePrisma & {
      runOperation: (
        a: unknown,
        meta?: { model?: string; operation?: string; delayMs?: number },
      ) => Promise<unknown>;
    };

    await runWithEvent({ eventId: "ev_pr_fast" }, async () => {
      await wrapped.runOperation({}, { model: "User", operation: "findMany" });
    });

    expect(sent.length).toBe(0);
  });
});
