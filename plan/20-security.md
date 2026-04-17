# 20 — Security

clearvoiance captures real traffic. That traffic contains secrets, PII, payment data, auth tokens, and anything else real users send to real servers. Treating this carelessly is a data breach waiting to happen. This doc is the security contract the project must uphold.

## Threat model

### Assets
- Captured event payloads (contain PII, secrets, auth material).
- Captured blob bodies (same, potentially worse — large documents).
- SDK API keys.
- Engine admin API keys.
- Storage credentials (ClickHouse, MinIO, Postgres).

### Adversaries
- **Opportunistic attacker** — internet scanner finding an unsecured engine endpoint.
- **Insider** — someone with partial access (e.g. read-only DB) trying to escalate.
- **Malicious contributor** — someone submitting a PR with a backdoor.
- **Supply chain** — compromised npm dependency.

### Out of scope (v1)
- Nation-state actor level defense (deep supply chain audits, hardware attestation).
- Confidentiality from the hosting provider (teams that need this should not self-host on shared infra).

## Principles

1. **No PII leaves the SUT unredacted.** Redaction happens in the SDK before transport.
2. **Defense in depth.** Multiple layers between an attacker and captured data.
3. **Secure by default.** Default configs are safe; insecure modes require explicit opt-in with loud warnings.
4. **Audit everything.** Every access to captured data is logged.
5. **Fail closed.** Misconfig = deny. Never fall through to unsafe behavior on error.

## PII redaction

### What must always be redacted

Default denylist — applied unless the operator explicitly removes items:

- Headers:
  - `authorization`
  - `cookie`
  - `set-cookie`
  - `x-api-key`
  - `x-auth-token`
  - `proxy-authorization`
- Body fields (JSONPath):
  - `$..password`
  - `$..passwd`
  - `$..secret`
  - `$..token`
  - `$..api_key`
  - `$..apiKey`
  - `$..credit_card`
  - `$..creditCard`
  - `$..card_number`
  - `$..cardNumber`
  - `$..cvv`
  - `$..ssn`
  - `$..social_security_number`

### Redaction mechanism

- Headers: value replaced with `[REDACTED]`, name preserved.
- JSON body: field set to `"[REDACTED]"` in-place; JSON structure intact.
- Non-JSON bodies with `content-type: application/x-www-form-urlencoded`: parse, redact matching keys, re-serialize.
- Binary bodies: no content-based redaction; user can opt to drop body entirely via `dropBinaryBodies: true`.
- Event retains `redactions_applied` list for audit (field names, not values).

### Configurable redaction

```ts
redaction: {
  headers: {
    deny: ['authorization', 'cookie', /^x-secret-/i],  // exact + regex
    allow: []  // overrides deny for specific items
  },
  body: {
    jsonPaths: {
      deny: ['$..password', '$..creditCard'],
      allow: []
    },
    dropIfLargerThan: 10 * 1024 * 1024,  // 10MB
    dropBinary: false
  },
  queryString: {
    denyParams: ['token', 'api_key']
  },
  custom: (event) => event  // user callback, runs last
}
```

### Testing redaction

- Every adapter has a redaction test suite.
- CI blocks commits that change default redaction rules without a conspicuous review.
- Operators can run `clearvoiance session lint <id>` to audit a session for redaction gaps (looks for suspicious patterns in stored events).

## Encryption

### At rest

- **ClickHouse**: server-side encryption at the storage layer. Use `encrypted_disks` with a keeper-managed master key.
- **MinIO**: SSE-S3 or SSE-KMS enabled via `MINIO_KMS_AUTO_ENCRYPTION=on`.
- **Postgres**: application-level crypt for sensitive columns (API key hashes already bcrypt'd).

### In transit

- **SDK ↔ Engine**: mTLS recommended, required in production deployments. Compose default: no TLS, loopback only.
- **Engine ↔ ClickHouse / Postgres / MinIO**: TLS enforced in Helm defaults.
- **UI ↔ Engine**: HTTPS enforced in Helm defaults.

### Keys
- Master keys via env vars or KMS (AWS KMS, GCP KMS, HashiCorp Vault).
- Key rotation: documented procedure; keys scoped per environment (never reuse across dev/staging/prod).

## Authentication & authorization

### API keys

- Format: `clv_live_<32 bytes base32>` (or `clv_test_` prefix for non-prod).
- Storage: bcrypt hash in Postgres. Plaintext returned on create, once.
- Scope: attached to an environment + a role.

### Roles (v1 minimal, v2 expansion)

**v1:**
- `admin`: all endpoints.

**v2:**
- `admin`: all.
- `operator`: create/read sessions + replays.
- `viewer`: read-only.
- `sdk`: capture-only (can only stream events for allowed sessions).

### Auth for UI

- UI logs in with an API key.
- Session stored in httpOnly cookie (not localStorage — for real deployments with OAuth proxy).
- For self-host dev: localStorage acceptable, flagged in docs.

### OAuth/SSO (Phase 8+)

- Engine accepts pre-authed headers from an OAuth proxy (e.g. oauth2-proxy, Traefik forward-auth).
- `X-Auth-User` header trusted when `engine.trustedForwardAuth=true`.
- Documented integration with: oauth2-proxy, Auth0, Okta, Keycloak.

## Input validation

- Every REST endpoint has request body validation (Go: `go-playground/validator`).
- Size limits on all payloads:
  - Event body inline: 64KB (configurable).
  - REST request body: 10MB (configurable).
  - Session import bundle: 10GB (documented).
- SQL-injection-proof via parameterized queries everywhere (sqlc, pgx).
- No user-provided content ever concatenated into SQL or shell commands.

## Hermetic mode safety

The whole point of hermetic mode is to prevent replay from producing real side effects. Safety requirements:

- `policy: strict` is the **default**. Unmocked outbound fails fast.
- `policy: passthrough` prints a loud warning to stderr on every real outbound.
- Env var `CLEARVOIANCE_HERMETIC=true` cannot be silently overridden.
- Hermetic mode check happens in the outbound patch BEFORE the network call; no race to patch-then-intercept.

## Supply chain

### npm (SDK)

- `pnpm-lock.yaml` committed.
- Dependabot enabled for security updates.
- `@clearvoiance/node` published with `provenance: true` via npm's OIDC provenance.
- Minimal runtime deps (currently ~5): smaller attack surface.
- CI runs `pnpm audit --audit-level=high` blocking.

### Go (engine)

- `go.sum` committed.
- `gosum` verification.
- `govulncheck` in CI.
- Dependency pinning; no `latest` tags.

### Docker images

- Multi-stage builds; final image based on `gcr.io/distroless/static` (no shell, no package manager).
- Images signed with **cosign** using keyless signatures (Sigstore).
- SBOM (`syft`) attached as artifact to each release.
- Vulnerability scan (`trivy`) in CI blocks release if HIGH findings.

## Secrets management

- No secrets in the repo. Ever.
- `.env.example` provided; real `.env` gitignored.
- Config supports secret refs: `dsn: "${SECRET_REF:vault:kv/clv/pg}"`.
- Engine refuses to start if a secret ref is unresolved in strict mode.

## Audit logging

- Every REST write op logs to `audit_log` (see Phase 5).
- Log retention: 1 year default, configurable.
- `/api/v1/audit` endpoint for query (admin only).
- Tamper evidence: audit log rows are append-only; CI compares log hashes on startup.

## Vulnerability disclosure

`SECURITY.md`:
- Private disclosure: `security@<domain>` with GPG key.
- Response SLAs:
  - Initial acknowledgement: 72 hours.
  - Triage: 7 days.
  - Fix target: 30 days for critical, 90 days for high, best-effort for medium/low.
- Hall of fame (opt-in).
- No bug bounty v1; reviewable based on adoption.

## Safe-mode operation

An operator can run clearvoiance in `safe_mode: true` which:
- Forces redaction.deny to the default list (can't be reduced).
- Disables `hermetic.policy: passthrough`.
- Disables `engine.trustedForwardAuth` unless mTLS is configured.
- Forces `audit_log_retention_days >= 365`.

Documented for regulated environments (healthcare, finance).

## Known limitations (publicly disclosed)

These are intentional v1 limitations, documented in `docs/concepts/security-limitations.md`:

- Binary payloads not redacted (dropped on opt-in only).
- Query text from DB observer may contain raw param values in slow log mode.
- Hermetic mode cannot intercept native SMTP connections.
- Self-hosted deployments are responsible for TLS, network policy, storage encryption.

## Compliance posture

- **GDPR**: captured data is personal data. Operators must have legal basis. Provide data-deletion tools: `clearvoiance session purge <id>`.
- **HIPAA**: not certified. Not in scope for v1.
- **SOC 2**: not certified. Project-level security posture documented; enterprise deployments handle their own controls.

## Security review cadence

- Each phase has a security review checkpoint before "done."
- External review (third-party firm or community audit) before Phase 8 launch.
- Annual review + update of this doc post-launch.
