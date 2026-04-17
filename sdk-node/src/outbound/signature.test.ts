import { describe, expect, it } from "vitest";

import { signatureOf } from "./signature.js";

describe("signatureOf", () => {
  it("is stable for identical inputs", () => {
    const a = signatureOf({
      method: "POST",
      host: "api.example.com",
      path: "/v1/foo",
      body: Buffer.from('{"x":1}'),
      contentType: "application/json",
    });
    const b = signatureOf({
      method: "POST",
      host: "api.example.com",
      path: "/v1/foo",
      body: Buffer.from('{"x":1}'),
      contentType: "application/json",
    });
    expect(a).toBe(b);
  });

  it("changes when method, host, path, or body change", () => {
    const base = {
      method: "POST",
      host: "api.example.com",
      path: "/v1/foo",
      body: Buffer.from('{"x":1}'),
      contentType: "application/json",
    };
    const sig = signatureOf(base);
    expect(signatureOf({ ...base, method: "PUT" })).not.toBe(sig);
    expect(signatureOf({ ...base, host: "api.other.com" })).not.toBe(sig);
    expect(signatureOf({ ...base, path: "/v1/bar" })).not.toBe(sig);
    expect(signatureOf({ ...base, body: Buffer.from('{"x":2}') })).not.toBe(sig);
  });

  it("is case-insensitive on method and host", () => {
    const a = signatureOf({
      method: "POST",
      host: "API.EXAMPLE.COM",
      path: "/x",
      body: undefined,
      contentType: undefined,
    });
    const b = signatureOf({
      method: "post",
      host: "api.example.com",
      path: "/x",
      body: undefined,
      contentType: undefined,
    });
    expect(a).toBe(b);
  });

  it("treats JSON bodies as equivalent when only ignored keys differ", () => {
    const cfg = { ignoreJsonKeys: ["timestamp", "nonce"] };
    const a = signatureOf(
      {
        method: "POST",
        host: "h",
        path: "/x",
        body: Buffer.from(
          JSON.stringify({ id: 1, timestamp: 1000, nonce: "abc", payload: "p" }),
        ),
        contentType: "application/json",
      },
      cfg,
    );
    const b = signatureOf(
      {
        method: "POST",
        host: "h",
        path: "/x",
        body: Buffer.from(
          JSON.stringify({ id: 1, timestamp: 9999, nonce: "xyz", payload: "p" }),
        ),
        contentType: "application/json",
      },
      cfg,
    );
    expect(a).toBe(b);
  });

  it("is insensitive to JSON key order", () => {
    const a = signatureOf({
      method: "POST",
      host: "h",
      path: "/x",
      body: Buffer.from(JSON.stringify({ a: 1, b: 2 })),
      contentType: "application/json",
    });
    const b = signatureOf({
      method: "POST",
      host: "h",
      path: "/x",
      body: Buffer.from(JSON.stringify({ b: 2, a: 1 })),
      contentType: "application/json",
    });
    expect(a).toBe(b);
  });

  it("produces the golden known-value for the engine-parity check", () => {
    // LOCKED: must match engine/internal/hermetic/signature_test.go
    // TestSignatureOf_KnownValue. Both sides hash the same canonical string
    // ("GET|api.example.com|/v1/ping|") so replay lookups match captures.
    const got = signatureOf({
      method: "GET",
      host: "api.example.com",
      path: "/v1/ping",
      body: undefined,
      contentType: undefined,
    });
    expect(got).toBe(
      "d742c96df79084737fe2997c202b3daa20fdc081479e92a187e9f21d02e1aac3",
    );
  });

  it("drops ignored query params and sorts remaining params", () => {
    const cfg = { ignoreQueryParams: ["cacheBust"] };
    const a = signatureOf(
      {
        method: "GET",
        host: "h",
        path: "/x?a=1&b=2&cacheBust=abc",
        body: undefined,
        contentType: undefined,
      },
      cfg,
    );
    const b = signatureOf(
      {
        method: "GET",
        host: "h",
        path: "/x?b=2&a=1&cacheBust=xyz",
        body: undefined,
        contentType: undefined,
      },
      cfg,
    );
    expect(a).toBe(b);
  });
});
