// 12 is about a send that waits while a lock is held. The scaffold's Publish
// holds b.mu and sends to each subscriber with a plain send. One subscriber
// that never reads blocks that send forever, so Publish never returns and
// b.mu is never released. Give every subscriber a buffered channel and send
// with `select { case ch <- e: default: }`: a full buffer drops the event for
// that subscriber only, and Publish moves on.
//
// The run is TestPublishNeverBlocksOnStalledSubscriber: a fast subscriber that
// drains chFast, a stalled one nobody reads, and 20 Publish calls on a
// goroutine, watched by a 200 ms safety net. That test fails on the scaffold.
// TestUnsubscribeStopsDelivery also fails there (Unsubscribe does nothing),
// but it is another run and shows no blocking, so no scene draws it.
// TestPubSubBasicDelivery passes on the scaffold.
//
// The subscriber set (b.subscribers) is not drawn. Both channels are always in
// it, in the order chFast, chStalled.

import {
  channel,
  close,
  defineViz,
  fail,
  go,
  goroutine,
  lock,
  mutex,
  onRecv,
  onSend,
  pass,
  recv,
  select,
  send,
  start,
  timer,
  unlock,
} from "../engine/ops.ts";
import type { Op, SelectResult } from "../engine/model.ts";

// What the engine sends back into a program: a RecvResult, a SelectResult, or
// nothing. `Program` in model.ts declares the same `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gen = Generator<Op, void, any>;

// Every number names its source in the committed exercise.
const K = {
  events: { value: 20, file: "check_test.go", text: "const numEvents = 20" },
  net: { value: 200, file: "check_test.go", text: "case <-time.After(200 * time.Millisecond):" },
  buffer: { value: 8, file: "README.md", text: "[cap 8]" },
} as const;

const N = K.events.value;
const CAP = K.buffer.value;

const tests = {
  publish: { name: "TestPublishNeverBlocksOnStalledSubscriber", short: "Publish returns" },
};

// The test's watcher: wait for `done`, or for the safety net.
function* watch(): Gen {
  yield start("net");
  const s: SelectResult = yield select([onRecv("done"), onRecv("net")]);
  yield s.i === 0 ? pass("publish") : fail("publish");
}

// The test's reader of chFast: `for range chFast {}`.
function* drain(): Gen {
  for (;;) {
    const r: { ok: boolean } = yield recv("chFast");
    if (!r.ok) return;
  }
}

// The test's publisher: numEvents Publish calls, then close(done). `body`
// is what Publish does to one subscriber's channel.
function publisher(body: (ch: string, i: number) => Gen): () => Gen {
  return function* (): Gen {
    for (let i = 0; i < N; i++) {
      yield lock("mu", { at: "b.mu.Lock()" });
      yield* body("chFast", i);
      yield* body("chStalled", i);
      yield unlock("mu", { at: "defer b.mu.Unlock()" });
    }
    yield close("done");
  };
}

const net = timer({ label: "time.After", pos: [3, 2], after: K.net.value });

const shared = () => ({
  mu: mutex({ label: "b.mu", pos: [0, 0] }),
  chFast: channel({ label: "fast", pos: [1, 0], cap: 0 }),
  chStalled: channel({ label: "stalled", pos: [1, 2], cap: 0 }),
  reader: goroutine({ label: "reader", pos: [2, 0], spawned: true, program: drain }),
  done: channel({ label: "done", pos: [2, 1], cap: 0 }),
  net,
});

const clock = { unit: "ms" } as const;

export default defineViz({
  schema: 3,
  exercise: "12-pub-sub",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:adc6a7d8", goal: "fnv1a:adc6a7d8" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `Publish holds b.mu and sends to the stalled subscriber's channel, which nobody reads, so the send never returns and b.mu is never released.`,
      model: {
        nodes: {
          Publish: goroutine({
            label: "Publish",
            pos: [0, 1],
            spawned: true,
            program: publisher(function* (ch): Gen {
              yield send(ch, "e", { at: "ch <- e" });
            }),
          }),
          main: goroutine({
            label: "main",
            pos: [3, 1],
            main: true,
            program: function* (): Gen {
              yield go("Publish");
              yield go("reader");
              yield* watch();
            },
          }),
          ...shared(),
        },
        insight: `Publish takes b.mu, hands the first event to the fast subscriber, then blocks on the stalled one: its channel has no buffer and nobody reads it. b.mu stays locked, so no later Publish gets in. After ${K.net.value} ms the test gives up. The blocked Publish is the learner's bug, not a test artefact.`,
        stops: [
          { when: { op: "block", node: "chStalled" }, say: "The stalled channel has no buffer and no reader, so this send waits. Publish still holds b.mu." },
          { when: { op: "fire", node: "net" }, say: `${K.net.value} ms pass and Publish is still stuck, holding b.mu. The test fails.` },
        ],
        tests,
        clock,
        code: {
          file: "main.go",
          text: `
@Publish func (b *EventBus) Publish(e Event) {
@Publish 	b.mu.Lock()
@Publish 	defer b.mu.Unlock()
@Publish
@Publish 	for _, ch := range b.subscribers {
@Publish 		ch <- e
@Publish 	}
@Publish }`,
        },
        expect: { outcome: "leak", t: K.net.value, tests: { publish: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Each subscriber has a buffer of ${CAP}. Publish sends without waiting and drops the event when a buffer is full, so all ${N} calls return.`,
      model: {
        nodes: {
          Publish: goroutine({
            label: "Publish",
            pos: [0, 1],
            spawned: true,
            program: publisher(function* (ch): Gen {
              yield select([onSend(ch, "e")], { default: true });
            }),
          }),
          main: goroutine({
            label: "main",
            pos: [3, 1],
            main: true,
            program: function* (): Gen {
              yield go("Publish");
              yield go("reader");
              yield* watch();
            },
          }),
          ...shared(),
          chFast: channel({ label: "fast", pos: [1, 0], cap: CAP }),
          chStalled: channel({ label: "stalled", pos: [1, 2], cap: CAP }),
        },
        insight: `The stalled channel takes ${CAP} events into its buffer and drops the other ${N - CAP}: its buffer is full and nobody reads it. Publish never waits, each call unlocks b.mu and returns, and all ${N} calls finish at once. The reader of the fast channel stays parked afterwards: that is the test's own loop, not a leak in the bus.`,
        stops: [
          { when: { op: "close", node: "done" }, say: `All ${N} Publish calls returned. The stalled channel holds ${CAP} events; the other ${N - CAP} were dropped.` },
        ],
        tests,
        clock,
        expect: { outcome: "leak", tests: { publish: "pass" } },
      },
    },
  ],
});
