import { describe, expect, it } from "vitest";

import { autoInstrument } from "./auto.js";
import type { Event as PbEvent } from "./generated/clearvoiance/v1/event.js";

class RecordingSink {
  async sendBatch(_events: PbEvent[]): Promise<void> {}
}

describe("autoInstrument", () => {
  it("detects an express app and installs captureHttp", async () => {
    const express = (await import("express")).default;
    const app = express();
    const h = await autoInstrument(new RecordingSink(), { app, skipOutbound: true });
    expect(h.detected).toContain("http.express");
    h.uninstall();
  });

  it("detects a koa app and installs captureKoa", async () => {
    const Koa = (await import("koa")).default;
    const app = new Koa();
    const h = await autoInstrument(new RecordingSink(), { app, skipOutbound: true });
    expect(h.detected).toContain("http.koa");
    h.uninstall();
  });

  it("detects a fastify instance and installs fastify capture", async () => {
    const Fastify = (await import("fastify")).default;
    const app = Fastify();
    const h = await autoInstrument(new RecordingSink(), { app, skipOutbound: true });
    expect(h.detected).toContain("http.fastify");
    h.uninstall();
    await app.close();
  });

  it("patches outbound http + fetch by default (no app)", async () => {
    const h = await autoInstrument(new RecordingSink());
    expect(h.detected).toContain("outbound.http");
    expect(h.detected).toContain("outbound.fetch");
    h.uninstall();
  });

  it("skipOutbound leaves global fetch + http.request untouched", async () => {
    const h = await autoInstrument(new RecordingSink(), { skipOutbound: true });
    expect(h.detected).not.toContain("outbound.http");
    expect(h.detected).not.toContain("outbound.fetch");
    h.uninstall();
  });
});
