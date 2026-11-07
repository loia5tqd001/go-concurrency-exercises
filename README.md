# Go Concurrency Exercises

## How to take this challenge

1. _Only edit `main.go`_ to solve the problem. Do not change other files.
2. If you find a `*_test.go` file, run `go test` to check your answer.
3. Want help or a comparison? [`solutions/`](solutions/) has a worked answer for every exercise. These contain spoilers.

## Overview

**Difficulty:** ![warm-up](https://img.shields.io/badge/-warm--up-lightgrey) &nbsp;![easy](https://img.shields.io/badge/-easy-brightgreen) &nbsp;![medium](https://img.shields.io/badge/-medium-blue) &nbsp;![hard](https://img.shields.io/badge/-hard-orange) &nbsp;![extreme](https://img.shields.io/badge/-extreme-red)

The exercises follow the order they were added. Difficulty usually
increases with the number. The order does not match every chapter in
_Concurrency in Go_. Some patterns arrived later than the patterns built
on them. Pipelines are one example.

Use [Suggested order, mapped to _Concurrency in Go_](#suggested-order-mapped-to-concurrency-in-go)
to follow the book order.

The table also tags each exercise by topic. Use
[Browse by topic](#browse-by-topic) for the reverse index. You can jump
to subjects such as `context` or `mutex`.

`14b`, `16b`, and `33b` are sequels. They keep a parent number with a
letter suffix. They do not renumber later exercises.

| #   | Challenge                                                                                                                                                |                          Difficulty                          | Topics                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------: | ------------------------------------------------------- |
| 0   | [Limit your Crawler](./00-limit-crawler)                                                       | ![warm-up](https://img.shields.io/badge/-warm--up-lightgrey) | `rate-limiting` `ticker` `goroutines-basics`            |
| 1   | [Producer-Consumer](./01-producer-consumer)                                                    | ![warm-up](https://img.shields.io/badge/-warm--up-lightgrey) | `channels` `goroutines-basics`                          |
| 2   | [Race in an LRU Cache](./02-race-in-cache)                                                     |     ![medium](https://img.shields.io/badge/-medium-blue)     | `mutex` `data-race` `lru-cache`                         |
| 3   | [Limit Service Time for Free-tier Users](./03-limit-service-time)                              |     ![medium](https://img.shields.io/badge/-medium-blue)     | `context` `mutex` `rate-limiting`                       |
| 4   | [Graceful SIGINT Killing](./04-graceful-sigint)                                                |   ![easy](https://img.shields.io/badge/-easy-brightgreen)    | `signals` `select` `graceful-shutdown`                  |
| 5   | [Clean Inactive Sessions to Prevent Memory Overflow](./05-session-cleaner)                     |      ![hard](https://img.shields.io/badge/-hard-orange)      | `mutex` `ticker` `background-worker`                    |
| 6   | [Fan-Out, Fan-In: Concurrent Thumbnail Generation](./06-fan-out-fan-in)                        |     ![medium](https://img.shields.io/badge/-medium-blue)     | `worker-pool` `fan-out-fan-in` `channels`               |
| 7   | [Or-Done Channel: Stopping a Monitoring Feed Cleanly](./07-or-done-channel)                    |     ![medium](https://img.shields.io/badge/-medium-blue)     | `done-channel` `channels` `goroutine-leak`              |
| 8   | [Pipeline: Multi-Stage Number Processing](./08-pipeline)                                       |     ![medium](https://img.shields.io/badge/-medium-blue)     | `pipeline` `channels` `context`                         |
| 9   | [Context Cancellation & Propagation](./09-context-cancellation)                                |   ![easy](https://img.shields.io/badge/-easy-brightgreen)    | `context` `cancellation`                                |
| 10  | [Semaphore: Bounding Parallelism Against a Rate-Limited API](./10-semaphore)                   |     ![medium](https://img.shields.io/badge/-medium-blue)     | `semaphore` `rate-limiting` `worker-pool`               |
| 11  | [Worker Pool: Batch Job Processor with Partial Failures](./11-worker-pool)                     |     ![medium](https://img.shields.io/badge/-medium-blue)     | `worker-pool` `channels`                                |
| 12  | [Pub-Sub: In-Memory Event Bus](./12-pub-sub)                                                   |     ![medium](https://img.shields.io/badge/-medium-blue)     | `pub-sub` `channels` `mutex`                            |
| 13  | [Channel of Channels (Bridge Pattern): Merging Dynamic Log Shards](./13-channel-of-channels)   |      ![hard](https://img.shields.io/badge/-hard-orange)      | `bridge-pattern` `fan-out-fan-in` `channels`            |
| 14  | [Tee Channel: Duplicating a Sensor Stream](./14-tee-channel)                                   |     ![medium](https://img.shields.io/badge/-medium-blue)     | `tee-channel` `select` `channels`                       |
| 14b | [Tee Channel, Independent Closing: Racing a Fast Consumer Past a Silent One](./14b-tee-channel-independent-close) |      ![hard](https://img.shields.io/badge/-hard-orange)      | `tee-channel` `select` `channels`                       |
| 15  | [Or-Channel Combinator: Combining Shutdown Triggers](./15-or-channel-combinator)               |      ![hard](https://img.shields.io/badge/-hard-orange)      | `or-channel` `select` `recursion`                       |
| 16  | [Your Own errgroup: Concurrent Tasks with First-Error Capture](./16-errgroup-failfast)         |     ![medium](https://img.shields.io/badge/-medium-blue)     | `errgroup` `sync.once` `worker-pool`                    |
| 16b | [errgroup.WithContext: Cancel-on-First-Error](./16b-errgroup-withcontext)                      |      ![hard](https://img.shields.io/badge/-hard-orange)      | `errgroup` `context` `cancellation`                     |
| 17  | [Future/Promise Pattern: Async, Memoized Computation](./17-future-promise)                     |      ![hard](https://img.shields.io/badge/-hard-orange)      | `future-promise` `channels` `sync.once` `memoization`   |
| 18  | [Bounded Pipeline with Backpressure](./18-bounded-pipeline-backpressure)                       |     ![medium](https://img.shields.io/badge/-medium-blue)     | `backpressure` `pipeline` `channels` `generics`          |
| 19  | [Actor Model: A Bank Account with No Locks](./19-actor-model)                                  |      ![hard](https://img.shields.io/badge/-hard-orange)      | `actor-model` `mutex-free`                              |
| 20  | [Concurrent Map-Reduce: Parallel Word Count](./20-concurrent-map-reduce)                       |     ![medium](https://img.shields.io/badge/-medium-blue)     | `map-reduce` `fan-out-fan-in` `mutex`                   |
| 21  | [Dining Philosophers: Deadlock Avoidance](./21-dining-philosophers)                            |      ![hard](https://img.shields.io/badge/-hard-orange)      | `deadlock` `mutex`                                      |
| 22  | [Circuit Breaker: Protecting a Flaky Payment Gateway](./22-circuit-breaker)                    |      ![hard](https://img.shields.io/badge/-hard-orange)      | `circuit-breaker` `state-machine` `mutex`               |
| 23  | [Sharded Concurrent Cache: Reducing Lock Contention](./23-sharded-cache)                       |     ![medium](https://img.shields.io/badge/-medium-blue)     | `sharding` `mutex` `hashing`                            |
| 24  | [Priority Worker Pool: Weighted Scheduling](./24-priority-worker-pool)                         |      ![hard](https://img.shields.io/badge/-hard-orange)      | `priority-queue` `container/heap` `sync.cond`           |
| 25  | [Graceful Multi-Stage Shutdown](./25-graceful-multistage-shutdown)                             |     ![medium](https://img.shields.io/badge/-medium-blue)     | `graceful-shutdown` `worker-pool` `sync.waitgroup`      |
| 26  | [Pipeline Error Handling: Result Values Instead of Aborting](./26-pipeline-error-handling)     |     ![medium](https://img.shields.io/badge/-medium-blue)     | `pipeline` `error-handling` `result-type`               |
| 27  | [Heartbeats: Detecting a Stalled Worker Before It's Too Late](./27-heartbeats)                 |     ![medium](https://img.shields.io/badge/-medium-blue)     | `heartbeats` `select` `timeout`                         |
| 28  | [Replicated Requests: Racing Redundant Calls for Lower Tail Latency](./28-replicated-requests) |      ![hard](https://img.shields.io/badge/-hard-orange)      | `replicated-requests` `fan-out-fan-in` `goroutine-leak` |
| 29  | [Healing Unhealthy Goroutines: A Steward That Restarts a Wedged Ward](./29-healing-goroutines) |      ![hard](https://img.shields.io/badge/-hard-orange)      | `steward` `heartbeats` `supervision`                    |
| 30  | [Livelock & Starvation: Two Failure Modes Beyond Deadlock](./30-livelock-starvation)           |     ![medium](https://img.shields.io/badge/-medium-blue)     | `livelock` `starvation` `fairness`                      |
| 31  | [Serve Timeout Race: First-Wins Response Under a Deadline](./31-serve-timeout-race)            |     ![medium](https://img.shields.io/badge/-medium-blue)     | `context` `deadline` `goroutine-leak`                   |
| 32  | [Racing a Fan-Out Against a Deadline](./32-fanout-deadline-race)                               |      ![hard](https://img.shields.io/badge/-hard-orange)      | `context` `deadline` `sync.waitgroup` `fan-out-fan-in` `goroutine-leak` |
| 33  | [Load Balancer: Self-Scheduling Workers That Report Their Own Load](./33-load-balancer)        |     ![medium](https://img.shields.io/badge/-medium-blue)     | `load-balancer` `container/heap` `worker-pool` `channels`    |
| 33b | [Non-Blocking Dispatch: A Load Balancer That Can't Depend on a Buffer](./33b-load-balancer-nonblocking-dispatch) |      ![hard](https://img.shields.io/badge/-hard-orange)      | `load-balancer` `container/heap` `select` `nil-channel`      |
| 34  | [Concurrent Prime Sieve: A Growing Pipeline That Must Learn to Shut Down](./34-prime-sieve)    |   ![easy](https://img.shields.io/badge/-easy-brightgreen)    | `prime-sieve` `pipeline` `done-channel` `goroutine-leak`     |
| 35  | [Your Own singleflight: Deduping In-Flight Duplicate Calls](./35-singleflight)                 |      ![hard](https://img.shields.io/badge/-hard-orange)      | `singleflight` `mutex` `sync.waitgroup`                      |
| 36  | [Batch Collector: A Reusable Batcher With a Deadline and a Real Shutdown](./36-batch-collector) |    ![extreme](https://img.shields.io/badge/-extreme-red)     | `batching` `channels` `mutex` `timer` `sync.waitgroup` `context` `graceful-shutdown` |
| 37  | [Safe Pool Shutdown: Closing a Multi-Producer Job Queue Without Panicking](./37-safe-pool-shutdown) |      ![hard](https://img.shields.io/badge/-hard-orange)      | `worker-pool` `graceful-shutdown` `sync.rwmutex` `sync.waitgroup` |
| 38  | [Settle Once: CompareAndSwap Between a Timeout and a Completion](./38-settle-once)      |     ![medium](https://img.shields.io/badge/-medium-blue)     | `atomic` `compare-and-swap` `mutex-free`                          |
| 39  | [Load Shedding: Reject Fast Instead of Blocking the Hot Path](./39-load-shedding)      |   ![easy](https://img.shields.io/badge/-easy-brightgreen)    | `worker-pool` `select` `load-shedding` `error-handling`         |

## Suggested order, mapped to _Concurrency in Go_

_Concurrency in Go_ builds patterns in a set order. Each section uses
ideas from earlier sections. If you read along, follow this order instead
of folder number.

This order puts pipelines before fan-out/fan-in. It puts tee before
bridge. It keeps livelock and starvation near deadlock. It keeps the
at-scale patterns together.

**Ch. 1 — Why concurrency is hard**

| Exercise                     | Failure mode                                    |
| ---------------------------- | ----------------------------------------------- |
| [02](02-race-in-cache)       | Race conditions & memory access synchronization |
| [21](21-dining-philosophers) | Deadlock                                        |
| [30](30-livelock-starvation) | Livelock & starvation                           |

**Ch. 2–3 — Goroutines, `sync`, channels, `select`**

| Exercise                      | Building block                                  |
| ----------------------------- | ----------------------------------------------- |
| [00](00-limit-crawler)        | Goroutines, `time.Ticker`                       |
| [01](01-producer-consumer)    | Channels, goroutines                            |
| [04](04-graceful-sigint)      | `select`, signals                               |
| [03](03-limit-service-time)   | `context`, `sync.Mutex`                         |
| [05](05-session-cleaner)      | `sync.Mutex`, `time.Ticker`, background workers |
| [10](10-semaphore)            | Channel-as-semaphore                            |
| [17](17-future-promise)       | Channel as async result holder                  |
| [16](16-errgroup-failfast)    | `sync.Once`, `sync.WaitGroup`                   |
| [16b](16b-errgroup-withcontext) | `context.WithCancel` (direct sequel to 16)    |
| [24](24-priority-worker-pool) | `sync.Cond`, `container/heap`                   |

**Ch. 4 — Concurrency patterns in Go**

| Exercise                               | Pattern                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| [20](20-concurrent-map-reduce)         | Confinement                                                                       |
| [08](08-pipeline)                      | Pipelines                                                                         |
| [06](06-fan-out-fan-in)                | Fan-out, fan-in                                                                   |
| [07](07-or-done-channel)               | The or-done-channel / preventing goroutine leaks                                  |
| [26](26-pipeline-error-handling)       | Error handling in pipelines                                                       |
| [14](14-tee-channel)                   | The tee-channel                                                                   |
| [14b](14b-tee-channel-independent-close) | The tee-channel, revisited: independent per-output closing                     |
| [13](13-channel-of-channels)           | The bridge-channel                                                                |
| [15](15-or-channel-combinator)         | The or-channel                                                                    |
| [18](18-bounded-pipeline-backpressure) | Queuing (the book argues _against_ unbounded buffering — this exercise shows why) |
| [09](09-context-cancellation)          | The `context` package                                                             |
| [11](11-worker-pool), [12](12-pub-sub) | Worker pools & pub-sub — repo extensions of the same channel-plumbing ideas       |

**Ch. 5 — Concurrency at scale**

| Exercise                              | Pattern                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| [27](27-heartbeats)                   | Heartbeats                                                              |
| [29](29-healing-goroutines)           | Healing unhealthy goroutines (steward)                                  |
| [28](28-replicated-requests)          | Replicated requests                                                     |
| [25](25-graceful-multistage-shutdown) | Graceful shutdown, revisited at the "is every worker really done" level |

**Beyond the book**

[19](19-actor-model), [22](22-circuit-breaker), and
[23](23-sharded-cache) are not in the book. They cover the actor model,
circuit breaker, and sharded cache. These patterns appear often in
production Go. Use them as a next step after the core material.

[31](31-serve-timeout-race) and [32](32-fanout-deadline-race) share a
theme. Both add a deadline to code that cannot enforce one. 31 handles
one synchronous handler. This is the shape an RPC server uses.

32 handles a `sync.WaitGroup` fan-out. It is the pattern in 25, but it
also waits on `ctx.Done()`. Both cover a slow loser goroutine. The loser
keeps running after the caller stops waiting. In 32, do not read the
shared result after you give up. Its writes may still be running.

[33](33-load-balancer) and [34](34-prime-sieve) come from Rob Pike's
2012 "Go Concurrency Patterns" talk. The book's pipeline and
fan-out/fan-in chapters also trace back to that talk. Both use this
repo's format: naive code with one bug.

33 is Pike's self-scheduling load balancer. It uses a
`container/heap`-ordered worker pool. Workers report completions to the
dispatcher. It extends the priority queue in
[24](24-priority-worker-pool) and the dynamic channels in
[13](13-channel-of-channels).

34 is Pike's concurrent prime sieve. The original runs forever by
design. This version must stop and clean up. It reuses the or-done idea
from [07](07-or-done-channel). The pipeline depth is not known until
runtime.

[33b](33b-load-balancer-nonblocking-dispatch) is a sequel to 33. It has
the same relationship [16b](16b-errgroup-withcontext) has to
[16](16-errgroup-failfast). The starting code has 33's fix. Then
`requestBacklogPerWorker` drops to `0`, which removes the buffer.

The dispatcher must work without that buffer. One goroutine sends work
and receives completions. A blocked send stops it from receiving the
completion that would unblock it.

The fix uses the `nil`-channel `select` idiom. A `nil` channel makes its
`case` never fire. This lets a conditional send join the same `select`.

[35](35-singleflight) is a hand-built version of
`golang.org/x/sync/singleflight`. It joins duplicate calls for one key.
This stops a cache stampede from causing many backend calls. Every
waiter gets the same value and error. The key is removed when the call
ends.

This differs from [17](17-future-promise). 17 keeps a result forever.
35 removes the key after the call finishes.

[36](36-batch-collector) and [37](37-safe-pool-shutdown) come from a
production Go codebase's internal concurrency toolkit. 36 is a reusable
scatter-gather batch collector. Real clients use this shape, such as a
Kafka producer's `linger.ms` or a Pub/Sub publisher's count and delay
limits.

Many goroutines add one request and get their own result. A batch runs
when either the count is reached or its deadline passes since its first
request. It then starts the next batch at once.

The count, deadline, and `Close` all race to fire the same batch once.
A stale timer must not touch a newer batch. `time.Timer.Stop()` does not
guarantee its callback is not already running.

`Close` follows `net/http.Server.Shutdown(ctx)`. It flushes queued work
and waits. It must also stop if the caller's context ends.

37 protects a multi-producer worker pool during shutdown. A submit can
race a close. The code must avoid a `send on closed channel` panic. It
is a harder version of the handshake in [11](11-worker-pool) and
[25](25-graceful-multistage-shutdown). A `sync.RWMutex` flag protects
it.

[38](38-settle-once) fills a different gap. Many exercises above that
share state use a mutex or channels. The mutex examples are
[02](02-race-in-cache),
[05](05-session-cleaner), [12](12-pub-sub),
[20](20-concurrent-map-reduce), [21](21-dining-philosophers),
[22](22-circuit-breaker), [23](23-sharded-cache),
[35](35-singleflight), [36](36-batch-collector), and
[37](37-safe-pool-shutdown). Channels appear in
[19](19-actor-model)'s actor model. None uses `sync/atomic` and
`CompareAndSwap`.

[31](31-serve-timeout-race) and [32](32-fanout-deadline-race) handle a
timeout race with one reader. It selects between a result channel and
`ctx.Done()`. 38 has no reader. Its completion and timeout paths are two
writers. Only one may cause the side effect.

A bool guard has a race like [02](02-race-in-cache). A mutex works but is
too much for one flag. `CompareAndSwap` lets the loser return at once.
It also beats `sync.Once` here. A `Once.Do` loser waits for the winner.
A timeout should return fast instead.

[39](39-load-shedding) asks one question. What happens when a bounded
channel feeding a fixed worker pool is full?

[18](18-bounded-pipeline-backpressure) and 33b answer in opposite ways.
18 should block, because the producer must feel the slowdown. 39's
caller is on a hot path and only records a metric. It can retry, drop,
or degrade.

39 uses `Submit` to fail fast with `ErrOverloaded`. The caller then knows
right away. It does not wait on a queue that cannot show if work is
briefly busy or stuck.

The fix is one `select` with a `default` case. This differs from 33b's
`nil` technique. A `nil` channel disables a case. `default` fires when
no real case can run at that moment.

## Browse by topic

<!-- BEGIN GENERATED topic-index: edit the overview table in README.md, then run `make gen` -->
| Topic                 | Exercises |
| --------------------- | --------- |
| `actor-model`         | [19](./19-actor-model) |
| `atomic`              | [38](./38-settle-once) |
| `background-worker`   | [05](./05-session-cleaner) |
| `backpressure`        | [18](./18-bounded-pipeline-backpressure) |
| `batching`            | [36](./36-batch-collector) |
| `bridge-pattern`      | [13](./13-channel-of-channels) |
| `cancellation`        | [09](./09-context-cancellation), [16b](./16b-errgroup-withcontext) |
| `channels`            | [01](./01-producer-consumer), [06](./06-fan-out-fan-in), [07](./07-or-done-channel), [08](./08-pipeline), [11](./11-worker-pool), [12](./12-pub-sub), [13](./13-channel-of-channels), [14](./14-tee-channel), [14b](./14b-tee-channel-independent-close), [17](./17-future-promise), [18](./18-bounded-pipeline-backpressure), [33](./33-load-balancer), [36](./36-batch-collector) |
| `circuit-breaker`     | [22](./22-circuit-breaker) |
| `compare-and-swap`    | [38](./38-settle-once) |
| `container/heap`      | [24](./24-priority-worker-pool), [33](./33-load-balancer), [33b](./33b-load-balancer-nonblocking-dispatch) |
| `context`             | [03](./03-limit-service-time), [08](./08-pipeline), [09](./09-context-cancellation), [16b](./16b-errgroup-withcontext), [31](./31-serve-timeout-race), [32](./32-fanout-deadline-race), [36](./36-batch-collector) |
| `data-race`           | [02](./02-race-in-cache) |
| `deadline`            | [31](./31-serve-timeout-race), [32](./32-fanout-deadline-race) |
| `deadlock`            | [21](./21-dining-philosophers) |
| `done-channel`        | [07](./07-or-done-channel), [34](./34-prime-sieve) |
| `errgroup`            | [16](./16-errgroup-failfast), [16b](./16b-errgroup-withcontext) |
| `error-handling`      | [26](./26-pipeline-error-handling), [39](./39-load-shedding) |
| `fairness`            | [30](./30-livelock-starvation) |
| `fan-out-fan-in`      | [06](./06-fan-out-fan-in), [13](./13-channel-of-channels), [20](./20-concurrent-map-reduce), [28](./28-replicated-requests), [32](./32-fanout-deadline-race) |
| `future-promise`      | [17](./17-future-promise) |
| `generics`            | [18](./18-bounded-pipeline-backpressure) |
| `goroutine-leak`      | [07](./07-or-done-channel), [28](./28-replicated-requests), [31](./31-serve-timeout-race), [32](./32-fanout-deadline-race), [34](./34-prime-sieve) |
| `goroutines-basics`   | [00](./00-limit-crawler), [01](./01-producer-consumer) |
| `graceful-shutdown`   | [04](./04-graceful-sigint), [25](./25-graceful-multistage-shutdown), [36](./36-batch-collector), [37](./37-safe-pool-shutdown) |
| `hashing`             | [23](./23-sharded-cache) |
| `heartbeats`          | [27](./27-heartbeats), [29](./29-healing-goroutines) |
| `livelock`            | [30](./30-livelock-starvation) |
| `load-balancer`       | [33](./33-load-balancer), [33b](./33b-load-balancer-nonblocking-dispatch) |
| `load-shedding`       | [39](./39-load-shedding) |
| `lru-cache`           | [02](./02-race-in-cache) |
| `map-reduce`          | [20](./20-concurrent-map-reduce) |
| `memoization`         | [17](./17-future-promise) |
| `mutex`               | [02](./02-race-in-cache), [03](./03-limit-service-time), [05](./05-session-cleaner), [12](./12-pub-sub), [20](./20-concurrent-map-reduce), [21](./21-dining-philosophers), [22](./22-circuit-breaker), [23](./23-sharded-cache), [35](./35-singleflight), [36](./36-batch-collector) |
| `mutex-free`          | [19](./19-actor-model), [38](./38-settle-once) |
| `nil-channel`         | [33b](./33b-load-balancer-nonblocking-dispatch) |
| `or-channel`          | [15](./15-or-channel-combinator) |
| `pipeline`            | [08](./08-pipeline), [18](./18-bounded-pipeline-backpressure), [26](./26-pipeline-error-handling), [34](./34-prime-sieve) |
| `prime-sieve`         | [34](./34-prime-sieve) |
| `priority-queue`      | [24](./24-priority-worker-pool) |
| `pub-sub`             | [12](./12-pub-sub) |
| `rate-limiting`       | [00](./00-limit-crawler), [03](./03-limit-service-time), [10](./10-semaphore) |
| `recursion`           | [15](./15-or-channel-combinator) |
| `replicated-requests` | [28](./28-replicated-requests) |
| `result-type`         | [26](./26-pipeline-error-handling) |
| `select`              | [04](./04-graceful-sigint), [14](./14-tee-channel), [14b](./14b-tee-channel-independent-close), [15](./15-or-channel-combinator), [27](./27-heartbeats), [33b](./33b-load-balancer-nonblocking-dispatch), [39](./39-load-shedding) |
| `semaphore`           | [10](./10-semaphore) |
| `sharding`            | [23](./23-sharded-cache) |
| `signals`             | [04](./04-graceful-sigint) |
| `singleflight`        | [35](./35-singleflight) |
| `starvation`          | [30](./30-livelock-starvation) |
| `state-machine`       | [22](./22-circuit-breaker) |
| `steward`             | [29](./29-healing-goroutines) |
| `supervision`         | [29](./29-healing-goroutines) |
| `sync.cond`           | [24](./24-priority-worker-pool) |
| `sync.once`           | [16](./16-errgroup-failfast), [17](./17-future-promise) |
| `sync.rwmutex`        | [37](./37-safe-pool-shutdown) |
| `sync.waitgroup`      | [25](./25-graceful-multistage-shutdown), [32](./32-fanout-deadline-race), [35](./35-singleflight), [36](./36-batch-collector), [37](./37-safe-pool-shutdown) |
| `tee-channel`         | [14](./14-tee-channel), [14b](./14b-tee-channel-independent-close) |
| `ticker`              | [00](./00-limit-crawler), [05](./05-session-cleaner) |
| `timeout`             | [27](./27-heartbeats) |
| `timer`               | [36](./36-batch-collector) |
| `worker-pool`         | [06](./06-fan-out-fan-in), [10](./10-semaphore), [11](./11-worker-pool), [16](./16-errgroup-failfast), [25](./25-graceful-multistage-shutdown), [33](./33-load-balancer), [37](./37-safe-pool-shutdown), [39](./39-load-shedding) |
<!-- END GENERATED topic-index -->

## Credit

This repo started as a fork of
[loong/go-concurrency-exercises](https://github.com/loong/go-concurrency-exercises).
It now has new exercises, rewritten scaffolds, and redesigned problems.
Credit to Long Hoang for the original idea and structure.

Most patterns here follow Katherine Cox-Buday's
[_Concurrency in Go_](https://www.oreilly.com/library/view/concurrency-in-go/9781491941294/)
(O'Reilly, 2017). The same applies to the
[Suggested order](#suggested-order-mapped-to-concurrency-in-go) above.

The book covers races, deadlock, livelock, and starvation. It covers
`sync`, channels, pipelines, fan-out/fan-in, or-done, tee, and bridge.
It also covers heartbeats, replicated requests, and worker health. If an
exercise feels familiar, the book likely explains it in more depth.
