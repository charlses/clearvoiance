import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../../generated/clearvoiance/v1/event.js";
import { registerCapture } from "./fastify.js";

class RecordingSink {
  public batches: PbEvent[][] = [];
  async sendBatch(events: PbEvent[]): Promise<void> {
    this.batches.push(events);
  }
  events(): PbEvent[] {
    return this.batches.flat();
  }
  inflight: Promise<unknown>[] = [];
  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.push(p);
    return p;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const info = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${info.port}`;
}

describe("registerCapture (Fastify adapter)", () => {
  let sink: RecordingSink;
  let app: FastifyInstance;

  beforeEach(() => {
    sink = new RecordingSink();
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
  });

  it("captures method, path, status, headers, and route template", async () => {
    registerCapture(app, sink);
    app.get("/users/:id", async (_req, reply) => {
      reply.header("x-test", "ok");
      reply.status(200);
      return { hello: "world" };
    });

    const base = await listen(app);
    const resp = await fetch(`${base}/users/42`, {
      headers: { "x-trace-id": "t-1", authorization: "Bearer secret" },
    });
    expect(resp.status).toBe(200);
    await resp.json();
    await sink.drain();

    const events = sink.events();
    expect(events).toHaveLength(1);
    const http = events[0]!.http!;
    expect(http.method).toBe("GET");
    expect(http.path).toBe("/users/42");
    expect(http.status).toBe(200);
    expect(http.routeTemplate).toBe("/users/:id");
    expect(http.durationNs).toBeGreaterThan(0n);
    expect(http.headers["x-trace-id"]?.values).toEqual(["t-1"]);
    expect(http.headers["authorization"]?.values).toEqual(["Bearer secret"]);
    expect(events[0]!.redactionsApplied).not.toContain("header:authorization");
  });

  it("captures request and response body bytes", async () => {
    registerCapture(app, sink);
    app.post("/echo", async (req, reply) => {
      reply.type("application/json").status(200);
      return req.body;
    });

    const base = await listen(app);
    const resp = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(resp.status).toBe(200);
    await resp.json();
    await sink.drain();

    const ev = sink.events()[0]!;
    const reqInline = ev.http?.requestBody?.inline;
    const resInline = ev.http?.responseBody?.inline;
    expect(reqInline).toBeDefined();
    expect(resInline).toBeDefined();
    expect(JSON.parse(Buffer.from(reqInline!).toString("utf-8"))).toEqual({
      hello: "world",
    });
    expect(JSON.parse(Buffer.from(resInline!).toString("utf-8"))).toEqual({
      hello: "world",
    });
  });

  it("userExtractor pulls from req.headers", async () => {
    registerCapture(app, sink, {
      userExtractor: (req) =>
        typeof req.headers["x-user"] === "string" ? req.headers["x-user"] : undefined,
    });
    app.get("/me", async () => ({ ok: true }));

    const base = await listen(app);
    await fetch(`${base}/me`, { headers: { "x-user": "u-1" } });
    await sink.drain();

    expect(sink.events()[0]!.http?.userId).toBe("u-1");
  });

  it("onError swallows sink failures without breaking the response", async () => {
    const failing = {
      sendBatch: async (): Promise<void> => {
        throw new Error("engine down");
      },
    };
    let captured: unknown = null;
    registerCapture(app, failing, { onError: (e) => (captured = e) });
    app.get("/ok", async () => "ok");

    const base = await listen(app);
    const resp = await fetch(`${base}/ok`);
    expect(resp.status).toBe(200);

    await new Promise((r) => setTimeout(r, 10));
    expect((captured as Error | null)?.message).toBe("engine down");
  });
});
