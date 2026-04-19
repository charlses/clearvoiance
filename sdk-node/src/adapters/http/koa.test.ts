import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Koa from "koa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../../generated/clearvoiance/v1/event.js";
import { captureKoa } from "./koa.js";

class RecordingSink {
  public batches: PbEvent[][] = [];
  async sendBatch(events: PbEvent[]): Promise<void> {
    this.batches.push(events);
  }
  events(): PbEvent[] {
    return this.batches.flat();
  }
}

function listen(app: Koa): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function readBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

describe("captureKoa (Koa adapter)", () => {
  let sink: RecordingSink;
  let server: Server;
  let base: string;

  beforeEach(() => {
    sink = new RecordingSink();
  });

  afterEach(async () => {
    if (server) await close(server);
  });

  it("captures method, path, status, duration, headers", async () => {
    const app = new Koa();
    app.use(captureKoa(sink));
    app.use(async (ctx) => {
      if (ctx.path === "/hello") {
        ctx.status = 200;
        ctx.body = { hello: "world" };
      }
    });

    ({ server, url: base } = await listen(app));
    const resp = await fetch(`${base}/hello`, {
      headers: { "x-trace-id": "t-1", authorization: "Bearer secret" },
    });
    expect(resp.status).toBe(200);
    await resp.json();

    await new Promise((r) => setImmediate(r));

    const events = sink.events();
    expect(events).toHaveLength(1);
    const http = events[0]!.http!;
    expect(http.method).toBe("GET");
    expect(http.path).toBe("/hello");
    expect(http.status).toBe(200);
    expect(http.durationNs).toBeGreaterThan(0n);
    expect(http.headers["x-trace-id"]?.values).toEqual(["t-1"]);
    expect(http.headers["authorization"]?.values).toEqual(["Bearer secret"]);
    expect(events[0]!.redactionsApplied).not.toContain("header:authorization");
  });

  it("captures the response body bytes Koa wrote to the wire", async () => {
    const app = new Koa();
    app.use(captureKoa(sink));
    app.use(async (ctx) => {
      ctx.type = "application/json";
      ctx.body = { greeting: "hi" };
    });

    ({ server, url: base } = await listen(app));
    const resp = await fetch(`${base}/`);
    const text = await readBody(resp.body);
    expect(JSON.parse(text)).toEqual({ greeting: "hi" });

    await new Promise((r) => setImmediate(r));

    const http = sink.events()[0]!.http!;
    const inline = http.responseBody?.inline;
    expect(inline).toBeDefined();
    expect(JSON.parse(Buffer.from(inline!).toString("utf-8"))).toEqual({ greeting: "hi" });
  });

  it("truncates request bodies larger than maxBodyInlineBytes", async () => {
    const app = new Koa();
    app.use(captureKoa(sink, { maxBodyInlineBytes: 8 }));
    app.use(async (ctx) => {
      // Drain the body so the request completes and finish fires.
      for await (const _ of ctx.req) {
        // just drain
      }
      ctx.status = 204;
    });

    ({ server, url: base } = await listen(app));
    await fetch(`${base}/big`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "0123456789ABCDEF",
    });

    await new Promise((r) => setImmediate(r));

    const ev = sink.events()[0]!;
    expect(ev.http?.requestBody?.inline?.length).toBe(8);
    expect(ev.http?.requestBody?.sizeBytes).toBe(8n);
    expect(ev.redactionsApplied).toContain("body:truncated");
  });

  it("userExtractor pulls from ctx.state", async () => {
    const app = new Koa();
    app.use(async (ctx, next) => {
      ctx.state.user = { id: "u-koa-42" };
      await next();
    });
    app.use(captureKoa(sink, { userExtractor: (ctx) => ctx.state.user?.id }));
    app.use(async (ctx) => {
      ctx.status = 200;
    });

    ({ server, url: base } = await listen(app));
    await fetch(`${base}/me`);
    await new Promise((r) => setImmediate(r));

    expect(sink.events()[0]!.http?.userId).toBe("u-koa-42");
  });

  it("does not break the response when sendBatch throws", async () => {
    const failing = {
      sendBatch: async (): Promise<void> => {
        throw new Error("engine down");
      },
    };
    let captured: unknown = null;
    const app = new Koa();
    app.use(captureKoa(failing, { onError: (err) => (captured = err) }));
    app.use(async (ctx) => {
      ctx.status = 200;
    });

    ({ server, url: base } = await listen(app));
    const resp = await fetch(`${base}/ok`);
    expect(resp.status).toBe(200);

    await new Promise((r) => setTimeout(r, 10));
    expect((captured as Error | null)?.message).toBe("engine down");
  });
});
