# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report them privately to:

**Email:** `davit.tavadzee@gmail.com`
**Subject line:** `[clearvoiance security] <short description>`

For sensitive reports, request a GPG key via the same email and encrypt the details.

### What to include

- A clear description of the vulnerability and its impact.
- Steps to reproduce.
- The affected component(s) and version(s).
- Any proof-of-concept code or sample payloads (attach, don't paste in plaintext if they contain real secrets).
- Your name / handle as you'd like to be credited (optional).

### Response SLA

| Stage | Target |
|---|---|
| Initial acknowledgement | 72 hours |
| Triage assessment | 7 days |
| Fix released (critical) | 30 days |
| Fix released (high) | 60 days |
| Fix released (medium/low) | Best effort, typically next release |

If you don't hear back within 72 hours of acknowledgement, resend the email.

## Supported versions

clearvoiance is pre-1.0. Security fixes land on the latest released version only until 1.0.

Post-1.0: we will support the current minor version and the previous minor (e.g. 1.4.x + 1.3.x).

## Disclosure policy

We follow **coordinated disclosure**:

1. You report the issue privately.
2. We acknowledge, triage, and develop a fix.
3. We release the fix in a new version.
4. After users have had reasonable time to upgrade (typically 7 days for critical, 30 days otherwise), we publish a public advisory via GitHub Security Advisories.
5. You are credited in the advisory unless you request otherwise.

If you believe the issue is being actively exploited in the wild, we will move faster and prioritize a public advisory.

## Out of scope

The following are NOT considered vulnerabilities by this project:

- Self-DoS (configuring your own engine to accept infinite captures and running out of disk).
- Missing security headers on UI pages served in local-dev mode (compose defaults — documented as dev-only).
- Issues in third-party dependencies unless clearvoiance uses them in a vulnerable way. Report those upstream.
- Findings from automated scanners without demonstrable impact.

## Hardening guidance

See [`docs/operations/security-hardening.md`](./docs/operations/security-hardening.md) for production deployment recommendations (TLS, API key management, storage encryption, network policy).

## Hall of fame

Security researchers who have responsibly disclosed issues will be listed here (with permission) after each fix is released.

_None yet._
