#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
architecture=${BUILD_ARCH:?set BUILD_ARCH to amd64 or arm64}
case "$architecture" in amd64|arm64) ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
output=${1:?provide a new output directory}
if [[ -e "$output" ]]; then echo 'Output directory already exists' >&2; exit 1; fi
mkdir -p "$output"
output=$(cd "$output" && pwd)
BUILD_ARCH="$architecture" bun run build
git show HEAD:apps/backend/setup.json > dist/setup.json
cp apps/backend/ceralive-esim-helper dist/esim-helper
cp -r scripts/esim dist/esim-source
cp docs/ESIM.md docs/ESIM-HELPER.md docs/LPAC.md docs/FORK-BUILDS.md dist/
# Development provenance includes the dirty flag because local source may be uncommitted.
source_commit=$(git rev-parse HEAD)
source_state=clean
if [[ -n "$(git status --porcelain)" ]]; then source_state=modified; fi
printf '{"sourceCommit":"%s","sourceState":"%s","architecture":"%s","development":true}\n' \
  "$source_commit" "$source_state" "$architecture" > dist/DEVELOPMENT_BUILD.json
tar --exclude='*.map' --exclude='__pycache__' -czf "$output/ceraui-${architecture}.tar.gz" -C dist .
(cd "$output" && sha256sum *.tar.gz > SHA256SUMS)
