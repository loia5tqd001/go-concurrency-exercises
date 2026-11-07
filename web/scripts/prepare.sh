#!/usr/bin/env bash
# Prepares everything Vite needs: a Go toolchain, the exercise code from
# git HEAD plus the docs from the working tree, and the Go toolchain that
# runs inside the browser.
set -euo pipefail
cd "$(dirname "$0")/.."

# Docs are read from the working tree; Go code from HEAD. This script
# regenerates the site data from the current docs on every dev/build run.

go_version=$(awk '$1 == "go" { print $2; exit }' ../go.mod)

if ! command -v go >/dev/null 2>&1; then
  # Vercel's build image has no Go. Fetch the exact version the exercises
  # pin; under node_modules/ it survives in Vercel's build cache.
  goroot="node_modules/.cache/go-toolchain/go$go_version"
  if [ ! -x "$goroot/bin/go" ]; then
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$(uname -m)" in
      x86_64) arch=amd64 ;;
      aarch64 | arm64) arch=arm64 ;;
      *) echo "prepare: unsupported architecture $(uname -m)" >&2; exit 1 ;;
    esac
    echo "prepare: downloading go$go_version for $os/$arch"
    mkdir -p "$goroot.tmp"
    curl -fsSL "https://go.dev/dl/go$go_version.$os-$arch.tar.gz" | tar -xz -C "$goroot.tmp"
    rm -rf "$goroot"
    mv "$goroot.tmp/go" "$goroot"
    rm -rf "$goroot.tmp"
  fi
  export PATH="$PWD/$goroot/bin:$PATH"
fi

if [ -n "${VERCEL:-}" ]; then
  export GOCACHE="$PWD/node_modules/.cache/go-build"
fi

go run ./tools/gen
go run ./tools/goassets
