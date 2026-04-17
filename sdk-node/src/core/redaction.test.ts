import { describe, expect, it } from "vitest";
import { DEFAULT_HEADER_DENY, redactHeaders } from "./redaction.js";

describe("redactHeaders", () => {
  it("redacts default-denied headers case-insensitively", () => {
    const { headers, applied } = redactHeaders({
      Authorization: "Bearer ey...",
      "Content-Type": "application/json",
      COOKIE: "session=abc",
    });
    expect(headers.authorization?.values).toEqual(["[REDACTED]"]);
    expect(headers.cookie?.values).toEqual(["[REDACTED]"]);
    expect(headers["content-type"]?.values).toEqual(["application/json"]);
    expect(applied.sort()).toEqual(["header:authorization", "header:cookie"]);
  });

  it("redacts headers matched by regex patterns", () => {
    const { headers, applied } = redactHeaders(
      { "x-secret-token": "abc", "x-public-id": "42" },
      { headers: DEFAULT_HEADER_DENY },
    );
    expect(headers["x-secret-token"]?.values).toEqual(["[REDACTED]"]);
    expect(headers["x-public-id"]?.values).toEqual(["42"]);
    expect(applied).toContain("header:x-secret-token");
  });

  it("preserves repeated header values and redacts each one", () => {
    const { headers } = redactHeaders({ "set-cookie": ["a=1", "b=2"] });
    expect(headers["set-cookie"]?.values).toEqual(["[REDACTED]", "[REDACTED]"]);
  });

  it("allows an empty denylist to pass everything through", () => {
    const { headers, applied } = redactHeaders(
      { Authorization: "Bearer ..." },
      { headers: [] },
    );
    expect(headers.authorization?.values).toEqual(["Bearer ..."]);
    expect(applied).toEqual([]);
  });

  it("skips undefined values", () => {
    const { headers } = redactHeaders({ foo: undefined });
    expect(headers.foo).toBeUndefined();
  });
});
