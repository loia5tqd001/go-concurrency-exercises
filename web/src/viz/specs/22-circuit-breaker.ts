// 22 has one state machine and two concurrency traps. Today and Goal show
// the README's level: every call reaching the gateway, then the breaker's
// three states. The inside scenes add the mutex, because "when does a caller
// wait" is the part of the exercise a paragraph cannot show.

import {
  add,
  channel,
  close,
  defineViz,
  done,
  fact,
  go,
  goroutine,
  inc,
  lock,
  mutex,
  pass,
  fail,
  recv,
  set,
  sleep,
  unlock,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { Op, RunSummary, TestDef } from "../engine/model.ts";

// The threshold and the cooldown are the README's numbers. The gateway
// delay, the sleeps, and the call counts are the committed test's numbers.
const K = {
  threshold: { value: 5, file: "README.md", text: "After **5 consecutive failures**" },
  sixthCall: { value: 6, file: "check_test.go", text: "expected ErrCircuitOpen on 6th call" },
  cooldownSecs: { value: 2, file: "check_test.go", text: "time.Sleep(2*time.Second + 10*time.Millisecond)" },
  marginMs: { value: 10, file: "check_test.go", text: "time.Sleep(2*time.Second + 10*time.Millisecond)" },
  afterTrial: { value: 3, file: "check_test.go", text: "for i := 0; i < 3; i++ {" },
  gatewayMs: { value: 150, file: "check_test.go", text: "const delay = 150 * time.Millisecond" },
  callers: { value: 2, file: "check_test.go", text: "wg.Add(2)" },
  headStart: { value: 3, file: "check_test.go", text: "time.Sleep(delay / 3)" },
} as const;

const N = K.threshold.value;
// The recovery tests sleep 2 s plus 10 ms, past the 2 s cooldown.
const pastCooldown = K.cooldownSecs.value * 1000 + K.marginMs.value;
const delay = K.gatewayMs.value;
// TestCircuitClosedDoesNotSerializeOnGatewayCall fails at delay*3/2.
const serialLimit = (delay * 3) / 2;
const headStart = delay / K.headStart.value;

const tests = {
  threshold: { name: "TestCircuitOpensAfterThreshold", short: "threshold" },
  recovery: { name: "TestCircuitHalfOpenRecovery", short: "recovery" },
  noserialize: {
    name: "TestCircuitClosedDoesNotSerializeOnGatewayCall",
    short: "no serialize",
    judge: (run: RunSummary) => run.t < serialLimit,
  },
  trial: { name: "TestCircuitHalfOpenTrialFailsFastForOthers", short: "trial" },
} satisfies Record<string, TestDef>;

// One Execute call while the gateway has no delay: it returns at once.
const execute = (): Op => work(0, "Execute");

// The two callers of TestCircuitClosedDoesNotSerializeOnGatewayCall, which
// the test starts together after wg.Add(2).
function lockScene(held: boolean) {
  return {
    nodes: {
      test: goroutine({
        label: "test",
        pos: [0, 1],
        main: true,
        program: function* () {
          yield add("wg", K.callers.value);
          yield go("caller[*]");
          // waitWithTimeout waits on wg from a helper goroutine only to
          // bound a hang; here the wait always returns.
          yield wait("wg");
        },
      }),
      wg: waitgroup({ label: "wg", pos: [1, 0] }),
      caller: goroutine({
        label: "caller",
        pos: [1, 1],
        count: K.callers.value,
        base: 1,
        spawned: true,
        program: held
          ? function* () {
              // The trap: the breaker keeps mu while Charge sleeps.
              yield lock("mu");
              yield work(delay, "Charge");
              yield unlock("mu");
              yield done("wg");
            }
          : function* () {
              yield lock("mu", { at: "cb.mu.Lock()" });
              yield unlock("mu", { at: "return true" });
              yield work(delay, "Charge");
              yield lock("mu", { at: "cb.afterCall(err)" });
              yield unlock("mu", { at: "cb.afterCall(err)" });
              yield done("wg");
            },
      }),
      mu: mutex({ label: "mu", pos: [2, 1] }),
    },
    tests: { noserialize: tests.noserialize },
    clock: { unit: "ms", budget: { at: serialLimit, label: "limit" } },
  } as const;
}

export default defineViz({
  schema: 3,
  exercise: "22-circuit-breaker",
  // The README draws the pass-through in one fence and the three states in
  // another, so Today and Goal mount on different doors.
  diagrams: { today: "fnv1a:7f76530e", goal: "fnv1a:4b22c4a7" },
  constants: K,
  anchors: [{ file: "check_test.go", text: "if elapsed >= delay*3/2 {" }],
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: "Execute passes every call straight to the gateway, so the 6th failing call reaches it too and the threshold test fails.",
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 0],
            main: true,
            program: function* () {
              for (let i = 1; i <= K.sixthCall.value; i++) {
                yield execute();
                yield inc("gateway", 1, { at: "return cb.gateway.Charge(amountCents)" });
              }
              // The 6th call returns ErrGatewayDown, not ErrCircuitOpen.
              yield fail("threshold");
            },
          }),
          gateway: fact({ label: "gateway", pos: [1, 0], value: 0, limit: N }),
        },
        insight: `Execute remembers nothing, so every call reaches the failing gateway. After ${N} failures the test expects the 6th call to fail fast; it reaches the gateway instead.`,
        stops: [
          {
            when: { op: "inc", node: "gateway", nth: K.sixthCall.value },
            say: "The 6th call reaches the gateway too and returns ErrGatewayDown. The test wanted ErrCircuitOpen.",
          },
        ],
        tests: { threshold: tests.threshold },
        code: {
          file: "main.go",
          text: `
type CircuitBreaker struct {
\tgateway *PaymentGateway
}
…
@caller func (cb *CircuitBreaker) Execute(amountCents int) error {
@caller \treturn cb.gateway.Charge(amountCents)
@caller }`,
        },
        expect: { outcome: "ok", tests: { threshold: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: "5 failures trip the breaker OPEN, the next call fails fast, and after the 2 s cooldown one trial call closes it again.",
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 0],
            main: true,
            program: function* () {
              for (let i = 1; i <= N; i++) {
                yield execute();
                yield inc("gateway");
              }
              yield set("breaker", "OPEN");
              // The 6th call: the breaker answers without the gateway.
              yield execute();
              // The gateway recovers; the test sleeps past the cooldown.
              yield sleep(pastCooldown);
              yield execute();
              yield set("breaker", "HALF-OPEN");
              yield inc("gateway");
              yield set("breaker", "CLOSED");
              for (let i = 0; i < K.afterTrial.value; i++) {
                yield execute();
                yield inc("gateway");
              }
              yield pass("recovery");
            },
          }),
          breaker: fact({ label: "breaker", pos: [1, 0], value: "CLOSED", states: ["CLOSED", "OPEN", "HALF-OPEN"] }),
          gateway: fact({ label: "gateway", pos: [2, 0], value: 0 }),
        },
        insight: `Watch gateway stop at ${N} calls while the breaker is OPEN: the 6th call fails fast. After the 2 s cooldown one trial call goes through, succeeds, and the breaker is CLOSED again.`,
        stops: [
          { when: { op: "set", node: "breaker", nth: 1 }, say: `The ${N}th failure in a row trips the breaker to OPEN.` },
          {
            when: { op: "work", g: "caller" },
            say: `The 6th call fails fast with ErrCircuitOpen: gateway stays at ${N} calls.`,
          },
          {
            when: { op: "set", node: "breaker", nth: 2 },
            say: "After the cooldown one trial call reaches the healthy gateway and succeeds, so the breaker is CLOSED.",
          },
        ],
        tests: { recovery: tests.recovery },
        clock: { unit: "ms" },
        expect: { outcome: "ok", t: pastCooldown, tests: { recovery: "pass" } },
      },
    },
    {
      id: "lock",
      chip: "Lock",
      tier: "inside",
      summary: "allow() holds mu only to check the state, so two callers' Charge calls overlap and the pair finishes in one delay.",
      model: {
        ...lockScene(false),
        insight: `Each caller holds mu only inside allow() and afterCall(), never across Charge. Both ${delay} ms calls overlap, so the pair is done at ${delay} ms, under the ${serialLimit} ms limit.`,
        stops: [
          {
            when: { op: "work", g: "caller", nth: 2 },
            say: "Both Charge calls run at once: allow() released mu before the slow call.",
          },
        ],
        code: {
          file: "solution",
          text: `
@caller func (cb *CircuitBreaker) Execute(amountCents int) error {
@caller \tif !cb.allow() {
@caller \t\treturn ErrCircuitOpen
@caller \t}
@caller
@caller \terr := cb.gateway.Charge(amountCents)
@caller \tcb.afterCall(err)
@caller \treturn err
@caller }
…
@caller func (cb *CircuitBreaker) allow() bool {
@caller \tcb.mu.Lock()
@caller \tdefer cb.mu.Unlock()
…
@caller \tcase stateClosed:
@caller \t\treturn true`,
        },
        expect: { outcome: "ok", t: delay, tests: { noserialize: "pass" } },
      },
    },
    {
      id: "held",
      chip: "Held",
      tier: "inside",
      summary: "The trap: a breaker that keeps mu across Charge makes the second caller wait, so the pair takes two delays.",
      model: {
        ...lockScene(true),
        insight: `Here the breaker keeps mu for the whole Charge. The second caller waits on mu.Lock() for ${delay} ms, so the pair takes ${2 * delay} ms, past the ${serialLimit} ms limit.`,
        stops: [
          {
            when: { op: "block", g: "caller" },
            say: "One caller waits on mu.Lock(): the other keeps mu for its whole Charge.",
          },
          {
            when: { op: "work", g: "caller" },
            say: `The second Charge starts only at ${delay} ms, a whole delay late.`,
          },
        ],
        expect: { outcome: "ok", t: 2 * delay, tests: { noserialize: "fail" } },
      },
    },
    {
      id: "trial",
      chip: "Trial",
      tier: "inside",
      summary: "Half-open lets one trial through. While its slow Charge runs, a second caller finds the slot taken and gets ErrCircuitOpen at once.",
      model: {
        nodes: {
          trial: goroutine({
            label: "trial",
            pos: [0, 0],
            spawned: true,
            program: function* ({ vars }) {
              // allow(): the cooldown is over, so this call takes the slot.
              yield lock("mu", { at: "cb.mu.Lock()" });
              vars.inFlight = 1;
              yield set("slot", "taken", { at: "cb.halfOpenInFlight = true" });
              yield unlock("mu", { at: "return true" });
              yield work(delay, "Charge");
              // afterCall(): the trial succeeded; the breaker closes.
              yield lock("mu", { at: "cb.afterCall(err)" });
              vars.inFlight = 0;
              yield set("slot", "free", { at: "cb.afterCall(err)" });
              yield unlock("mu", { at: "cb.afterCall(err)" });
              yield close("trialDone");
            },
          }),
          slot: fact({ label: "trial slot", pos: [0, 1], value: "free", states: ["free", "taken"] }),
          trialDone: channel({ label: "trialDone", pos: [1, 0], cap: 0 }),
          mu: mutex({ label: "mu", pos: [1.5, 1] }),
          test: goroutine({
            label: "test",
            pos: [2, 0],
            main: true,
            program: function* ({ vars }) {
              // Five failing calls with no delay trip the breaker open.
              for (let i = 0; i < N; i++) yield execute();
              yield sleep(pastCooldown);
              yield go("trial");
              yield sleep(headStart);
              // The second call. executeWithTimeout runs it on a helper
              // goroutine only to bound a hang; it returns at once here.
              yield execute();
              yield lock("mu", { at: "cb.mu.Lock()" });
              // The trial started a third of a delay earlier, so the slot
              // is always taken by now.
              if (vars.inFlight !== 1) throw new Error("the second call found the trial slot free");
              yield unlock("mu", { at: "return false" });
              yield recv("trialDone");
              yield pass("trial");
            },
          }),
        },
        insight: `The trial takes the slot under mu, then lets mu go before its ${delay} ms Charge. The test calls Execute ${headStart} ms later, locks mu at once, sees the slot taken, and gets ErrCircuitOpen without waiting.`,
        stops: [
          { when: { op: "lock", g: "test" }, say: "The trial holds the slot, not mu, during Charge, so the test's second call locks mu at once." },
          {
            when: { op: "unlock", g: "test" },
            say: `The slot is taken, so Execute returns ErrCircuitOpen ${delay - headStart} ms before the trial ends.`,
          },
          { when: { op: "set", node: "slot" }, say: "The trial succeeds: the slot is free and the breaker is closed again." },
        ],
        tests: { trial: tests.trial },
        clock: { unit: "ms" },
        code: {
          file: "solution",
          text: `
@trial,test func (cb *CircuitBreaker) Execute(amountCents int) error {
@trial,test \tif !cb.allow() {
@test \t\treturn ErrCircuitOpen
@trial,test \t}
@trial
@trial \terr := cb.gateway.Charge(amountCents)
@trial \tcb.afterCall(err)
…
@trial,test \tcb.mu.Lock()
@trial,test \tdefer cb.mu.Unlock()
…
@trial \t\tcb.state = stateHalfOpen
@trial \t\tcb.halfOpenInFlight = true
@trial \t\treturn true
@test
@test \tcase stateHalfOpen:
@test \t\tif cb.halfOpenInFlight {
@test \t\t\t// Trial slot already taken; fail fast.
@test \t\t\treturn false`,
        },
        expect: { outcome: "ok", t: pastCooldown + delay, tests: { trial: "pass" } },
      },
    },
  ],
});
