#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:?usage: build-cli-release.sh <tag> <output-directory>}"
OUTPUT="${2:?usage: build-cli-release.sh <tag> <output-directory>}"
REPOSITORY="${MULTICA_RELEASE_REPOSITORY:?set MULTICA_RELEASE_REPOSITORY}"
CHANNEL="${MULTICA_RELEASE_CHANNEL:-ipoke}"
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid release repository' >&2; exit 1; }
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-ipoke\.[0-9a-f]{7,40}$ ]] || { echo 'Invalid ipoke release tag' >&2; exit 1; }
REVISION="$(git -C "$ROOT_DIR" rev-parse HEAD)"
git -C "$ROOT_DIR" diff --quiet && git -C "$ROOT_DIR" diff --cached --quiet || { echo 'Release source must be clean' >&2; exit 1; }
[[ "$REVISION" == "${TAG##*-ipoke.}"* ]] || { echo 'Tag suffix must identify the source commit' >&2; exit 1; }
VERSION="${TAG#v}"
BUILD_DATE="$(git -C "$ROOT_DIR" show -s --format=%cI HEAD)"
mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for platform in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  target_os="${platform%/*}"
  target_arch="${platform#*/}"
  payload="$WORK/$target_os-$target_arch"
  mkdir -p "$payload"
  binary=multica
  extension=tar.gz
  if [ "$target_os" = windows ]; then binary=multica.exe; extension=zip; fi
  (cd "$ROOT_DIR/server" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build \
    -ldflags "-s -w -X main.version=$VERSION -X main.commit=$REVISION -X main.buildCommit=$REVISION -X main.date=$BUILD_DATE -X main.releaseChannel=$CHANNEL -X main.upgradeGuideURL=https://ipoke.si/download -X github.com/multica-ai/multica/server/internal/cli.releaseRepository=$REPOSITORY" \
    -o "$payload/$binary" ./cmd/multica)
  cp "$ROOT_DIR/LICENSE" "$ROOT_DIR/NOTICE" "$payload/"
  archive="$OUTPUT/multica-cli-$VERSION-$target_os-$target_arch.$extension"
  if [ "$extension" = zip ]; then
    (cd "$payload" && zip -q "$archive" "$binary" LICENSE NOTICE)
  else
    tar -czf "$archive" -C "$payload" "$binary" LICENSE NOTICE
  fi
  printf 'Built %s\n' "${archive##*/}"
done
(cd "$OUTPUT" && if command -v sha256sum >/dev/null 2>&1; then sha256sum multica-cli-*; else shasum -a 256 multica-cli-*; fi) > "$OUTPUT/checksums.txt"
