# Releasing @clearvoiance/node

Publishing is tag-driven. A push of a `v<semver>` tag on `main` triggers
`.github/workflows/publish-sdk.yml`, which runs tests + build, then
publishes to npm with provenance.

## Prerequisites (one-time)

- `NPM_TOKEN` GitHub repo secret — an **Automation** token from npm
  (bypasses 2FA so CI can publish). Scope to `@clearvoiance/*` if npm
  shows that option on token creation.
- `@clearvoiance` org exists on npm and you're a member.

## Release steps

1. Merge everything you want in the release to `main` and confirm CI is green.
2. Bump `sdk-node/package.json#version` to the new semver. The prebuild
   hook (`scripts/sync-version.mjs`) rewrites `src/version.ts` so the
   runtime `SDK_VERSION` constant always matches — commit that change
   along with the bump.
3. Tag + push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. Watch `publish @clearvoiance/node` in GitHub Actions. The tag is
   cross-checked against `package.json#version`; a mismatch hard-fails
   before `npm publish` runs.
5. Verify: https://www.npmjs.com/package/@clearvoiance/node.

## Versioning

- Pre-1.0 (today): treat minor bumps as "may break"; patch bumps are
  strictly additive. Phase 8 flips us to full semver.
- The wire protocol (the proto package + the engine's `/api/v1`) is
  versioned separately from the SDK. An SDK minor bump can still talk
  to an older engine as long as no new fields are *required*.

## Rolling back

npm doesn't allow re-publishing a version. If a bad build lands:

1. `npm deprecate @clearvoiance/node@<bad-version> "critical bug; use @<good-version>"`
2. Bump to the next patch with the fix and publish. Deprecation shows a
   warning on install without breaking existing lockfiles.

## Version sync sanity check (local)

```bash
pnpm --filter @clearvoiance/node sync-version
git diff sdk-node/src/version.ts   # empty = in sync
```
