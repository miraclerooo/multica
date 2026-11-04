# Release runbook

## Normal release

Release from a reviewed commit on `main` by creating and pushing a new semantic
version tag such as `v0.18.4`. The Release workflow intentionally has no manual
trigger: a tag push is the only event that can publish binaries, Homebrew
formulae, and container images.

The verification job runs the Go tests and `govulncheck` before any publishing
job starts. The vulnerability scan is fail-closed by default.

CI and release jobs require Go `~1.27.3`: at least 1.27.3, while accepting
newer 1.27 patches. This security floor is independent of the development
minimum in `server/go.mod`. A plain `1.27.x` can resolve to an older patch
while the `setup-go` version manifest catches up with an official Go release.
When raising the security floor, update all Go workflows and the pinned
Go builder image in `Dockerfile` together so shipped binaries also receive
the fixes.

## Emergency vulnerability-scan bypass

Use the bypass only when `govulncheck` itself or its live vulnerability database
is unavailable, or when maintainers have documented a confirmed false positive
that blocks an urgent release. Never use it to publish a release with an
unresolved reachable vulnerability.

1. Record the reason and maintainer approval in the release issue or pull
   request, and confirm no other release is in progress.
2. In **Settings → Secrets and variables → Actions → Variables**, set the
   repository variable `ALLOW_VULN_BYPASS_FOR_TAG` to the exact release tag,
   for example `v0.18.4`.
3. Re-run the failed Release workflow for that tag. A different tag, an empty
   value, or any typo keeps the scan enabled.
4. Confirm the verification log contains the explicit bypass warning and retain
   the workflow URL in the incident record.
5. Delete `ALLOW_VULN_BYPASS_FOR_TAG` immediately after the release run
   completes. The tag-scoped value prevents a concurrent release with another
   tag from inheriting the bypass.

Every Go binary retains its compiler version in the standard Go build metadata;
use `go version -m <binary>` when auditing a downloaded release artifact.

## ipoke CLI channel

Tag an approved main commit as `vX.Y.Z-ipoke.<commit-prefix>` (at least seven
hex characters). The separate **ipoke CLI Release** workflow migrates an
isolated PostgreSQL database, runs the guarded Go suite and govulncheck, then
publishes six CLI archives with checksums to the current repository. It does
not publish the upstream Homebrew package or desktop installers.

The build embeds the current repository as the update source. Set
`MULTICA_CLI_RELEASE_REPOSITORY` on both backend and web build/runtime to show
that repository's install commands on the download page and runtime setup
surfaces. The web build also needs `MULTICA_DAEMON_SERVER_URL` and
`MULTICA_APP_URL` for the self-host setup command. Install scripts take
`MULTICA_RELEASE_REPOSITORY`; custom installs verify checksums and use direct
archives. `multica version --output json` reports `release_repository`.
