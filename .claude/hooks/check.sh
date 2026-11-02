#!/bin/sh
# Runs tools/check for a Claude Code hook. It builds a binary first because
# `go run` turns every non-zero exit into 1, and a hook must exit 2 to block.
# If the build fails, this exits 1, which lets the action through: a broken
# checker must never lock an agent out.
set -e
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
# Rebuild only when a source is newer than the binary; this keeps each hook
# call near 10ms instead of the ~400ms that go build's own check costs.
if [ ! -x .claude/.bin/check ] || [ -n "$(find tools/check go.mod -newer .claude/.bin/check 2>/dev/null)" ]; then
	go build -o .claude/.bin/check ./tools/check
fi
exec .claude/.bin/check "$@"
