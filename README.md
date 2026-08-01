# Go Concurrency Exercises [![Build Status](https://travis-ci.org/loong/go-concurrency-exercises.svg?branch=main)](https://travis-ci.org/loong/go-concurrency-exercises) [![Go Report Card](https://goreportcard.com/badge/github.com/loong/go-concurrency-exercises)](https://goreportcard.com/report/github.com/loong/go-concurrency-exercises)
Exercises for Golang's concurrency patterns.

## Why
The Go community has plenty resources to read about go's concurrency model and how to use it effectively. But *who actually wants to read all this*!? This repo tries to teach concurrency patterns by following the 'learning by doing' approach.

![Image of excited gopher](https://golang.org/doc/gopher/pkg.png)

## How to take this challenge
1. *Only edit `main.go`* to solve the problem. Do not touch any of the other files.
2. If you find a `*_test.go` file, you can test the correctness of your solution with `go test`
3. If you get stuck, join us on [Discord](https://discord.com/invite/golang) or [Slack](https://invite.slack.golangbridge.org/)! Surely there are people who are happy to give you some code reviews (if not, find me via `@loong` ;) )
4. Still stuck, or want to compare notes after solving it? [`solutions/`](solutions/) has a verified, worked write-up for every exercise (spoilers, obviously).

## Overview

**Difficulty:** ![warm-up](https://img.shields.io/badge/-warm--up-lightgrey) &nbsp;![easy](https://img.shields.io/badge/-easy-brightgreen) &nbsp;![medium](https://img.shields.io/badge/-medium-blue) &nbsp;![hard](https://img.shields.io/badge/-hard-orange) &nbsp;![extreme](https://img.shields.io/badge/-extreme-red)

The exercises are numbered in the order we'd recommend doing them — difficulty generally increases with the number, but the table below also tags each one by topic so you can jump straight to, say, everything about `context` or every `mutex` exercise. See [Browse by topic](#browse-by-topic) for the reverse index.

| # | Challenge | Difficulty | Topics |
| - |-----------|:---:|--------|
| 0 | [Limit your Crawler](https://github.com/loong/go-concurrency-exercises/tree/main/0-limit-crawler) | ![warm-up](https://img.shields.io/badge/-warm--up-lightgrey) | `rate-limiting` `ticker` `goroutines-basics` |
| 1 | [Producer-Consumer](https://github.com/loong/go-concurrency-exercises/tree/main/1-producer-consumer) | ![warm-up](https://img.shields.io/badge/-warm--up-lightgrey) | `channels` `goroutines-basics` |
| 2 | [Race Condition in Caching Cache](https://github.com/loong/go-concurrency-exercises/tree/main/2-race-in-cache#race-condition-in-caching-szenario) | ![easy](https://img.shields.io/badge/-easy-brightgreen) | `mutex` `data-race` `lru-cache` |
| 3 | [Limit Service Time for Free-tier Users](https://github.com/loong/go-concurrency-exercises/tree/main/3-limit-service-time) | ![medium](https://img.shields.io/badge/-medium-blue) | `context` `mutex` `rate-limiting` |
| 4 | [Graceful SIGINT Killing](https://github.com/loong/go-concurrency-exercises/tree/main/4-graceful-sigint) | ![easy](https://img.shields.io/badge/-easy-brightgreen) | `signals` `select` `graceful-shutdown` |
| 5 | [Clean Inactive Sessions to Prevent Memory Overflow](https://github.com/loong/go-concurrency-exercises/tree/main/5-session-cleaner) | ![medium](https://img.shields.io/badge/-medium-blue) | `mutex` `ticker` `background-worker` |
| 6 | [Fan-Out, Fan-In: Concurrent Thumbnail Generation](https://github.com/loong/go-concurrency-exercises/tree/main/6-fan-out-fan-in) | ![easy](https://img.shields.io/badge/-easy-brightgreen) | `worker-pool` `fan-out-fan-in` `channels` |
| 7 | [Or-Done Channel: Stopping a Monitoring Feed Cleanly](https://github.com/loong/go-concurrency-exercises/tree/main/7-or-done-channel) | ![medium](https://img.shields.io/badge/-medium-blue) | `done-channel` `channels` `goroutine-leak` |
| 8 | [Pipeline: Multi-Stage Number Processing](https://github.com/loong/go-concurrency-exercises/tree/main/8-pipeline) | ![medium](https://img.shields.io/badge/-medium-blue) | `pipeline` `channels` `context` |
| 9 | [Context Cancellation & Propagation](https://github.com/loong/go-concurrency-exercises/tree/main/9-context-cancellation) | ![easy](https://img.shields.io/badge/-easy-brightgreen) | `context` `cancellation` |
| 10 | [Semaphore: Bounding Parallelism Against a Rate-Limited API](https://github.com/loong/go-concurrency-exercises/tree/main/10-semaphore) | ![medium](https://img.shields.io/badge/-medium-blue) | `semaphore` `rate-limiting` `worker-pool` |
| 11 | [Worker Pool: Batch Job Processor with Partial Failures](https://github.com/loong/go-concurrency-exercises/tree/main/11-worker-pool) | ![easy](https://img.shields.io/badge/-easy-brightgreen) | `worker-pool` `channels` |
| 12 | [Pub-Sub: In-Memory Event Bus](https://github.com/loong/go-concurrency-exercises/tree/main/12-pub-sub) | ![medium](https://img.shields.io/badge/-medium-blue) | `pub-sub` `channels` `mutex` |
| 13 | [Channel of Channels (Bridge Pattern): Merging Dynamic Log Shards](https://github.com/loong/go-concurrency-exercises/tree/main/13-channel-of-channels) | ![hard](https://img.shields.io/badge/-hard-orange) | `bridge-pattern` `fan-out-fan-in` `channels` |
| 14 | [Tee Channel: Duplicating a Sensor Stream](https://github.com/loong/go-concurrency-exercises/tree/main/14-tee-channel) | ![medium](https://img.shields.io/badge/-medium-blue) | `tee-channel` `select` `channels` |
| 15 | [Or-Channel Combinator: Combining Shutdown Triggers](https://github.com/loong/go-concurrency-exercises/tree/main/15-or-channel-combinator) | ![hard](https://img.shields.io/badge/-hard-orange) | `or-channel` `select` `recursion` |
| 16 | [Your Own errgroup: Concurrent Tasks with First-Error Capture](https://github.com/loong/go-concurrency-exercises/tree/main/16-errgroup-failfast) | ![medium](https://img.shields.io/badge/-medium-blue) | `errgroup` `sync.once` `worker-pool` |
| 17 | [Future/Promise Pattern: Async, Memoized Computation](https://github.com/loong/go-concurrency-exercises/tree/main/17-future-promise) | ![medium](https://img.shields.io/badge/-medium-blue) | `future-promise` `sync.once` |
| 18 | [Bounded Pipeline with Backpressure](https://github.com/loong/go-concurrency-exercises/tree/main/18-bounded-pipeline-backpressure) | ![medium](https://img.shields.io/badge/-medium-blue) | `backpressure` `pipeline` `channels` |
| 19 | [Actor Model: A Bank Account with No Locks](https://github.com/loong/go-concurrency-exercises/tree/main/19-actor-model) | ![hard](https://img.shields.io/badge/-hard-orange) | `actor-model` `mutex-free` |
| 20 | [Concurrent Map-Reduce: Parallel Word Count](https://github.com/loong/go-concurrency-exercises/tree/main/20-concurrent-map-reduce) | ![medium](https://img.shields.io/badge/-medium-blue) | `map-reduce` `fan-out-fan-in` `mutex` |
| 21 | [Dining Philosophers: Deadlock Avoidance](https://github.com/loong/go-concurrency-exercises/tree/main/21-dining-philosophers) | ![hard](https://img.shields.io/badge/-hard-orange) | `deadlock` `mutex` |
| 22 | [Circuit Breaker: Protecting a Flaky Payment Gateway](https://github.com/loong/go-concurrency-exercises/tree/main/22-circuit-breaker) | ![hard](https://img.shields.io/badge/-hard-orange) | `circuit-breaker` `state-machine` `mutex` |
| 23 | [Sharded Concurrent Cache: Reducing Lock Contention](https://github.com/loong/go-concurrency-exercises/tree/main/23-sharded-cache) | ![hard](https://img.shields.io/badge/-hard-orange) | `sharding` `mutex` `hashing` |
| 24 | [Priority Worker Pool: Weighted Scheduling](https://github.com/loong/go-concurrency-exercises/tree/main/24-priority-worker-pool) | ![extreme](https://img.shields.io/badge/-extreme-red) | `priority-queue` `container/heap` `sync.cond` |
| 25 | [Graceful Multi-Stage Shutdown](https://github.com/loong/go-concurrency-exercises/tree/main/25-graceful-multistage-shutdown) | ![hard](https://img.shields.io/badge/-hard-orange) | `graceful-shutdown` `worker-pool` `sync.waitgroup` |

## Browse by topic

| Topic | Exercises |
|-------|-----------|
| `actor-model` | [19](https://github.com/loong/go-concurrency-exercises/tree/main/19-actor-model) |
| `background-worker` | [5](https://github.com/loong/go-concurrency-exercises/tree/main/5-session-cleaner) |
| `backpressure` | [18](https://github.com/loong/go-concurrency-exercises/tree/main/18-bounded-pipeline-backpressure) |
| `bridge-pattern` | [13](https://github.com/loong/go-concurrency-exercises/tree/main/13-channel-of-channels) |
| `cancellation` | [9](https://github.com/loong/go-concurrency-exercises/tree/main/9-context-cancellation) |
| `channels` | [1](https://github.com/loong/go-concurrency-exercises/tree/main/1-producer-consumer), [6](https://github.com/loong/go-concurrency-exercises/tree/main/6-fan-out-fan-in), [7](https://github.com/loong/go-concurrency-exercises/tree/main/7-or-done-channel), [8](https://github.com/loong/go-concurrency-exercises/tree/main/8-pipeline), [11](https://github.com/loong/go-concurrency-exercises/tree/main/11-worker-pool), [12](https://github.com/loong/go-concurrency-exercises/tree/main/12-pub-sub), [13](https://github.com/loong/go-concurrency-exercises/tree/main/13-channel-of-channels), [14](https://github.com/loong/go-concurrency-exercises/tree/main/14-tee-channel), [18](https://github.com/loong/go-concurrency-exercises/tree/main/18-bounded-pipeline-backpressure) |
| `circuit-breaker` | [22](https://github.com/loong/go-concurrency-exercises/tree/main/22-circuit-breaker) |
| `container/heap` | [24](https://github.com/loong/go-concurrency-exercises/tree/main/24-priority-worker-pool) |
| `context` | [3](https://github.com/loong/go-concurrency-exercises/tree/main/3-limit-service-time), [8](https://github.com/loong/go-concurrency-exercises/tree/main/8-pipeline), [9](https://github.com/loong/go-concurrency-exercises/tree/main/9-context-cancellation) |
| `data-race` | [2](https://github.com/loong/go-concurrency-exercises/tree/main/2-race-in-cache) |
| `deadlock` | [21](https://github.com/loong/go-concurrency-exercises/tree/main/21-dining-philosophers) |
| `done-channel` | [7](https://github.com/loong/go-concurrency-exercises/tree/main/7-or-done-channel) |
| `errgroup` | [16](https://github.com/loong/go-concurrency-exercises/tree/main/16-errgroup-failfast) |
| `fan-out-fan-in` | [6](https://github.com/loong/go-concurrency-exercises/tree/main/6-fan-out-fan-in), [13](https://github.com/loong/go-concurrency-exercises/tree/main/13-channel-of-channels), [20](https://github.com/loong/go-concurrency-exercises/tree/main/20-concurrent-map-reduce) |
| `future-promise` | [17](https://github.com/loong/go-concurrency-exercises/tree/main/17-future-promise) |
| `goroutine-leak` | [7](https://github.com/loong/go-concurrency-exercises/tree/main/7-or-done-channel) |
| `goroutines-basics` | [0](https://github.com/loong/go-concurrency-exercises/tree/main/0-limit-crawler), [1](https://github.com/loong/go-concurrency-exercises/tree/main/1-producer-consumer) |
| `graceful-shutdown` | [4](https://github.com/loong/go-concurrency-exercises/tree/main/4-graceful-sigint), [25](https://github.com/loong/go-concurrency-exercises/tree/main/25-graceful-multistage-shutdown) |
| `hashing` | [23](https://github.com/loong/go-concurrency-exercises/tree/main/23-sharded-cache) |
| `lru-cache` | [2](https://github.com/loong/go-concurrency-exercises/tree/main/2-race-in-cache) |
| `map-reduce` | [20](https://github.com/loong/go-concurrency-exercises/tree/main/20-concurrent-map-reduce) |
| `mutex` | [2](https://github.com/loong/go-concurrency-exercises/tree/main/2-race-in-cache), [3](https://github.com/loong/go-concurrency-exercises/tree/main/3-limit-service-time), [5](https://github.com/loong/go-concurrency-exercises/tree/main/5-session-cleaner), [12](https://github.com/loong/go-concurrency-exercises/tree/main/12-pub-sub), [20](https://github.com/loong/go-concurrency-exercises/tree/main/20-concurrent-map-reduce), [21](https://github.com/loong/go-concurrency-exercises/tree/main/21-dining-philosophers), [22](https://github.com/loong/go-concurrency-exercises/tree/main/22-circuit-breaker), [23](https://github.com/loong/go-concurrency-exercises/tree/main/23-sharded-cache) |
| `mutex-free` | [19](https://github.com/loong/go-concurrency-exercises/tree/main/19-actor-model) |
| `or-channel` | [15](https://github.com/loong/go-concurrency-exercises/tree/main/15-or-channel-combinator) |
| `pipeline` | [8](https://github.com/loong/go-concurrency-exercises/tree/main/8-pipeline), [18](https://github.com/loong/go-concurrency-exercises/tree/main/18-bounded-pipeline-backpressure) |
| `priority-queue` | [24](https://github.com/loong/go-concurrency-exercises/tree/main/24-priority-worker-pool) |
| `pub-sub` | [12](https://github.com/loong/go-concurrency-exercises/tree/main/12-pub-sub) |
| `rate-limiting` | [0](https://github.com/loong/go-concurrency-exercises/tree/main/0-limit-crawler), [3](https://github.com/loong/go-concurrency-exercises/tree/main/3-limit-service-time), [10](https://github.com/loong/go-concurrency-exercises/tree/main/10-semaphore) |
| `recursion` | [15](https://github.com/loong/go-concurrency-exercises/tree/main/15-or-channel-combinator) |
| `select` | [4](https://github.com/loong/go-concurrency-exercises/tree/main/4-graceful-sigint), [14](https://github.com/loong/go-concurrency-exercises/tree/main/14-tee-channel), [15](https://github.com/loong/go-concurrency-exercises/tree/main/15-or-channel-combinator) |
| `semaphore` | [10](https://github.com/loong/go-concurrency-exercises/tree/main/10-semaphore) |
| `sharding` | [23](https://github.com/loong/go-concurrency-exercises/tree/main/23-sharded-cache) |
| `signals` | [4](https://github.com/loong/go-concurrency-exercises/tree/main/4-graceful-sigint) |
| `state-machine` | [22](https://github.com/loong/go-concurrency-exercises/tree/main/22-circuit-breaker) |
| `sync.cond` | [24](https://github.com/loong/go-concurrency-exercises/tree/main/24-priority-worker-pool) |
| `sync.once` | [16](https://github.com/loong/go-concurrency-exercises/tree/main/16-errgroup-failfast), [17](https://github.com/loong/go-concurrency-exercises/tree/main/17-future-promise) |
| `sync.waitgroup` | [25](https://github.com/loong/go-concurrency-exercises/tree/main/25-graceful-multistage-shutdown) |
| `tee-channel` | [14](https://github.com/loong/go-concurrency-exercises/tree/main/14-tee-channel) |
| `ticker` | [0](https://github.com/loong/go-concurrency-exercises/tree/main/0-limit-crawler), [5](https://github.com/loong/go-concurrency-exercises/tree/main/5-session-cleaner) |
| `worker-pool` | [6](https://github.com/loong/go-concurrency-exercises/tree/main/6-fan-out-fan-in), [10](https://github.com/loong/go-concurrency-exercises/tree/main/10-semaphore), [11](https://github.com/loong/go-concurrency-exercises/tree/main/11-worker-pool), [16](https://github.com/loong/go-concurrency-exercises/tree/main/16-errgroup-failfast), [25](https://github.com/loong/go-concurrency-exercises/tree/main/25-graceful-multistage-shutdown) |

## License

```
 DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE 
                    Version 2, December 2004 

 Copyleft from 2017 Long Hoang

 Everyone is permitted to copy and distribute verbatim or modified 
 copies of this license document, and changing it is allowed as long 
 as the name is changed.

            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE 
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION 

  0. You just DO WHAT THE FUCK YOU WANT TO.
```
