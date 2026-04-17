import { describe, expect, it } from "vitest";
import { SDK_VERSION, createClient } from "./index.js";

describe("@clearvoiance/node", () => {
  it("exports a non-empty SDK_VERSION", () => {
    expect(SDK_VERSION).toBeTypeOf("string");
    expect(SDK_VERSION.length).toBeGreaterThan(0);
  });

  it("createClient returns an object carrying the SDK version", () => {
    const client = createClient({
      engine: { url: "grpc://localhost:9100", apiKey: "test" },
      session: { name: "test" },
    });

    expect(client.version).toBe(SDK_VERSION);
  });
});
