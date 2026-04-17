import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWithEvent } from "../core/event-context.js";
import type { Event as PbEvent } from "../generated/clearvoiance/v1/event.js";
import { patchHttp, targetFromHost } from "./http.js";

// The patch mutates the CJS `node:http` module.exports — which is what
// CJS consumers (axios, node-fetch, etc.) actually see. The ESM namespace
// view is a frozen snapshot, so we grab the CJS module for testing; this
// matches how real-world HTTP clients resolve the module.
const nodeRequire = createRequire(import.meta.url);
const http = nodeRequire("node:http") as typeof import("node:http");

class RecordingSink {
  public batches: PbEvent[][] = [];
  async sendBatch(events: PbEvent[]): Promise<void> {
    this.batches.push(events);
  }
  events(): PbEvent[] {
    return this.batches.flat();
  }
  // Exposed so the patch awaits our async work during tests.
  inflight: Promise<unknown>[] = [];
  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.push(p);
    return p;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}

function listen(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c.toString()));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ echoed: body, method: req.method, url: req.url }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
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

describe("patchHttp (outbound HTTP capture)", () => {
  let sink: RecordingSink;
  let server: Server;
  let base: string;
  let uninstall: (() => void) | null = null;

  beforeEach(async () => {
    sink = new RecordingSink();
    ({ server, url: base } = await listen());
  });

  afterEach(async () => {
    if (uninstall) uninstall();
    uninstall = null;
    await close(server);
  });

  it("records outbound calls fired inside a capture scope", async () => {
    const handle = patchHttp(sink);
    uninstall = handle.uninstall;

    await runWithEvent({ eventId: "ev_parent_1" }, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(`${base}/hello`, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve());
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });
    });

    await sink.drain();

    const events = sink.events();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.outbound).toBeDefined();
    expect(ev.outbound!.causedByEventId).toBe("ev_parent_1");
    expect(ev.outbound!.http!.method).toBe("GET");
    expect(ev.outbound!.http!.path).toBe("/hello");
    expect(ev.outbound!.http!.status).toBe(200);
    expect(ev.outbound!.responseHash.length).toBe(32); // sha256
  });

  it("passes through calls made outside any capture scope", async () => {
    const handle = patchHttp(sink);
    uninstall = handle.uninstall;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${base}/no-scope`, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });

    await sink.drain();
    expect(sink.events()).toHaveLength(0);
  });

  it("captures the request body written via .end(body)", async () => {
    const handle = patchHttp(sink);
    uninstall = handle.uninstall;

    await runWithEvent({ eventId: "ev_parent_2" }, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          `${base}/echo`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ hello: "world" }));
      });
    });

    await sink.drain();

    const ev = sink.events()[0]!;
    const reqBody = ev.outbound!.http!.requestBody!;
    expect(reqBody.inline).toBeDefined();
    expect(JSON.parse(Buffer.from(reqBody.inline!).toString("utf-8"))).toEqual({
      hello: "world",
    });
  });

  it("skips calls to denylisted hosts", async () => {
    const handle = patchHttp(sink, { skipHosts: ["127.0.0.1"] });
    uninstall = handle.uninstall;

    await runWithEvent({ eventId: "ev_parent_3" }, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(`${base}/skipped`, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.end();
      });
    });

    await sink.drain();
    expect(sink.events()).toHaveLength(0);
  });

  it("uninstall restores the original http.request", () => {
    const before = http.request;
    const handle = patchHttp(sink);
    expect(http.request).not.toBe(before);
    handle.uninstall();
    expect(http.request).toBe(before);
  });
});

describe("targetFromHost", () => {
  it("collapses api.<vendor>.tld to <vendor>.api", () => {
    expect(targetFromHost("api.telegram.org")).toBe("telegram.api");
    expect(targetFromHost("api.openai.com")).toBe("openai.api");
  });
  it("returns the last two segments for other hosts", () => {
    expect(targetFromHost("a.b.example.com")).toBe("example.com");
    expect(targetFromHost("example.com")).toBe("example.com");
  });
  it("leaves single-label hosts alone (e.g. localhost, minio.local)", () => {
    expect(targetFromHost("localhost")).toBe("localhost");
    expect(targetFromHost("minio.local")).toBe("minio.local");
  });
});
