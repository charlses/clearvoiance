import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Koa from "koa";
import { describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../../generated/clearvoiance/v1/event.js";
import { clearvoianceStrapiMiddleware } from "./strapi.js";

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

describe("clearvoianceStrapiMiddleware (Strapi factory)", () => {
  it("returns a Strapi-style factory that produces a working middleware", async () => {
    const sink = new RecordingSink();
    // Strapi calls `(config, { strapi }) => middleware`; args are ignored by us.
    const factory = clearvoianceStrapiMiddleware(sink, {
      userExtractor: (ctx) => (ctx.state as { user?: { id?: string } }).user?.id,
    });
    const middleware = factory({}, { strapi: {} });
    expect(typeof middleware).toBe("function");

    const app = new Koa();
    app.use(async (ctx, next) => {
      // Simulate Strapi's auth having already populated ctx.state.user.
      ctx.state.user = { id: "u-strapi-7" };
      await next();
    });
    app.use(middleware);
    app.use(async (ctx) => {
      ctx.status = 200;
      ctx.body = { ok: true };
    });

    const { server, url } = await listen(app);
    try {
      const resp = await fetch(`${url}/api/articles`);
      expect(resp.status).toBe(200);
      await resp.json();
      await new Promise((r) => setImmediate(r));

      const events = sink.events();
      expect(events).toHaveLength(1);
      const http = events[0]!.http!;
      expect(http.method).toBe("GET");
      expect(http.path).toBe("/api/articles");
      expect(http.status).toBe(200);
      expect(http.userId).toBe("u-strapi-7");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
