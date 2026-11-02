# Entry points for people and agents. AGENTS.md says when to run each one.
# All of them call tools/check, which holds the rules.

.PHONY: setup lint gen check verify try

# Install the commit gate (.githooks/pre-commit). Run once per clone.
setup:
	git config core.hooksPath .githooks

# Static rules on the working tree: layout, README tables, docs, gofmt.
lint:
	go run ./tools/check lint

# Rewrite the README sections that are derived from the overview table.
gen:
	go run ./tools/check gen

# Everything the commit gate checks: lint, plus every scaffold in the index
# builds, passes go vet, and fails its own tests fast.
check: lint
	go run ./tools/check scaffolds

# EX=36: your scaffold in the working tree fails its tests 10 times in 10.
verify:
	go run ./tools/check scaffolds -src=worktree -runs=10 $(EX)

# EX=36 MAIN=/tmp/ref.go: a candidate solution passes 20 runs with -race,
# in a temp copy. No main.go in the repo is touched.
try:
	go run ./tools/check try $(EX) $(MAIN)
