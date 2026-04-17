import { describe, expect, it } from "vitest";
import { Client, SDK_VERSION, createClient } from "./index.js";

describe("@clearvoiance/node public API", () => {
  it("exports a non-empty SDK_VERSION", () => {
    expect(SDK_VERSION).toBeTypeOf("string");
    expect(SDK_VERSION.length).toBeGreaterThan(0);
  });

  it("createClient returns a Client instance", () => {
    const client = createClient({
      engine: { url: "127.0.0.1:9100", apiKey: "test" },
      session: { name: "unit" },
    });
    expect(client).toBeInstanceOf(Client);
  });
});
