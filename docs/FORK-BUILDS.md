# Fork development builds

The Fork development artifacts workflow builds the application and delivers amd64 and ARM64 archives. It runs on branch pushes and manual dispatch. Artifact jobs wait for lint/typecheck, unit tests, technical-debt checks and release/package contracts. The pinned SRTLA runtime is verified before backend tests run.

## Branch roles

Keep `main` and every other upstream branch name at the corresponding upstream commit. The `fork` branch is the downstream integration branch for development builds and fork-specific changes. Start downstream-only topic branches from `fork` and target their pull requests back to `fork`.

Start upstream-bound topics from upstream `main`, then open their pull requests against upstream `main`. Keep the fork build workflow, container and packaging changes out of those topics. Merge the clean feature branches into `fork` for integration; do not merge `fork` back into an upstream-bound topic. Update published integration history with merges instead of rewriting it.

The eSIM integration adds its helper, source recipe and supporting engineering instructions to development application archives. Host provisioning remains an explicit administrator action.

## Building artifacts

Use Bun 1.4.3, Node 26 and the frozen lockfile. The reusable container supplies packaging tools and native test prerequisites.

```sh
docker build -t ceraui-build-tools -f scripts/fork/Dockerfile .
bun install --frozen-lockfile
bun run lint
bun run test
bun run check:tech-debt
bun run test:release-package-contracts
BUILD_ARCH=amd64 scripts/fork/package.sh dist-artifacts/amd64
BUILD_ARCH=arm64 scripts/fork/package.sh dist-artifacts/arm64
```

Each packaging command requires a new output directory. It produces `ceraui-<architecture>.tar.gz` and `SHA256SUMS`. `DEVELOPMENT_BUILD.json` records the source commit, architecture and whether the source tree was modified. The archive includes the committed setup defaults and excludes source maps.

For container tests, use the default unprivileged user, `--init`, a 0022 umask and a checkout bind mount at `/work`. Use `bash -c` to retain the image's system-tool PATH. Namespace integration tests require an isolated container with `SYS_ADMIN`, `NET_ADMIN` and an unconfined seccomp profile. The container's sudo rule permits `unshare` for those tests.

Development archive delivery uses GitHub Actions artifacts. Signed production releases require the release workflow's signing and publication infrastructure. Native hardware qualification has its own acceptance gates.
