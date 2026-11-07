# Graceful SIGINT Killing

`main` runs a process forever. Right now Ctrl-C kills it at once. The
program never gets a chance to stop the process cleanly. This is why
`net/http.Server` has `Shutdown`:

```
today:
  Ctrl-C ──▶ OS kills immediately
             proc.Stop() never runs

goal:
  1st Ctrl-C ──▶ proc.Stop()
                 keep running
  2nd Ctrl-C ──▶ kill now
```

`main` only calls `proc.Run()`. It does not handle SIGINT. The first
Ctrl-C kills the program, and `proc.Stop()` never runs.

## Your task

Change `main` so that:

- On the first Ctrl-C, call `proc.Stop()`.
- Keep the program running while `proc.Stop()` works.
- On the second Ctrl-C, end the program at once.

The mock `Stop()` never returns. Do not wait for it to finish.

## Test your solution

```
go test -v
go test -race
```
