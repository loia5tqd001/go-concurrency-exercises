# Graceful SIGINT Killing

`main` runs a long-lived process with no shutdown path except letting
the OS kill it outright on Ctrl-C - the same gap any long-running
worker, daemon, or CLI needs closed before it's production-ready, the
same way `net/http.Server` needs `Shutdown` instead of a bare Ctrl-C:

```
today:
  Ctrl-C ──▶ OS kills immediately
             proc.Stop() never runs

goal:
  1st Ctrl-C ──▶ proc.Stop()
                 keep running
  2nd Ctrl-C ──▶ kill now
```

Right now `main` just calls `proc.Run()` directly - there is no signal
handling at all, so the OS's default SIGINT disposition applies: the
very first Ctrl-C kills the program outright, mid-work, and
`proc.Stop()` is never called.

## Your task

Change `main` so that:

- On the **first** SIGINT, it calls `proc.Stop()` to try to shut the
  process down gracefully - and the program must keep running while
  that's in progress. (The mock's `Stop()` never actually returns, by
  design, so waiting for it to finish is not an option.)
- On a **second** SIGINT, it kills the program promptly - whether or
  not the graceful stop from the first one is still running.

## Test your solution

```
go test -v
go test -race
```
