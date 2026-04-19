import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEADER_DENY,
  RECOMMENDED_HEADER_DENY_PRODUCTION,
  redactHeaders,
} from "./redaction.js";

describe("redactHeaders", () => {
  it("captures everything by default (DEFAULT_HEADER_DENY is empty)", () => {
    // The default is full-fidelity — captured traffic replays faithfully
    // without auth-strategy acrobatics. Operators opt into redaction by
    // passing RECOMMENDED_HEADER_DENY_PRODUCTION or their own matchers.
    expect(DEFAULT_HEADER_DENY).toEqual([]);
    const { headers, applied } = redactHeaders({
      Authorization: "Bearer ey...",
      "Content-Type": "application/json",
      COOKIE: "session=abc",
    });
    expect(headers.authorization?.values).toEqual(["Bearer ey..."]);
    expect(headers.cookie?.values).toEqual(["session=abc"]);
    expect(headers["content-type"]?.values).toEqual(["application/json"]);
    expect(applied).toEqual([]);
  });

  it("redacts common auth headers case-insensitively with RECOMMENDED set", () => {
    const { headers, applied } = redactHeaders(
      {
        Authorization: "Bearer ey...",
        "Content-Type": "application/json",
        COOKIE: "session=abc",
      },
      { headers: RECOMMENDED_HEADER_DENY_PRODUCTION },
    );
    expect(headers.authorization?.values).toEqual(["[REDACTED]"]);
    expect(headers.cookie?.values).toEqual(["[REDACTED]"]);
    expect(headers["content-type"]?.values).toEqual(["application/json"]);
    expect(applied.sort()).toEqual(["header:authorization", "header:cookie"]);
  });

  it("redacts headers matched by regex patterns", () => {
    const { headers, applied } = redactHeaders(
      { "x-secret-token": "abc", "x-public-id": "42" },
      { headers: RECOMMENDED_HEADER_DENY_PRODUCTION },
    );
    expect(headers["x-secret-token"]?.values).toEqual(["[REDACTED]"]);
    expect(headers["x-public-id"]?.values).toEqual(["42"]);
    expect(applied).toContain("header:x-secret-token");
  });

  it("preserves repeated header values and redacts each one when opted in", () => {
    const { headers } = redactHeaders(
      { "set-cookie": ["a=1", "b=2"] },
      { headers: RECOMMENDED_HEADER_DENY_PRODUCTION },
    );
    expect(headers["set-cookie"]?.values).toEqual(["[REDACTED]", "[REDACTED]"]);
  });

  it("skips undefined values", () => {
    const { headers } = redactHeaders({ foo: undefined });
    expect(headers.foo).toBeUndefined();
  });
});
