// 19 turns one shared balance into a message-passing protocol. Today animates
// the unchecked-withdrawal outcome; it does not model the unsynchronized
// load/store race. Goal shows the README contract: callers send requests to
// one actor and wait on per-request reply channels. The inside scenes expose
// the serial loop, atomic check-then-debit, and Close.
//
// TestAccountWithdrawRejectsInsufficientFunds and
// TestAccountBasicOperations do not close their accounts, so their actor is
// still blocked after the test returns. Those scenes end as leaks and say so;
// that is the committed fixture lifetime, not a failed actor implementation.
//
// The engine cannot wait for one goroutine to exit. The Close scene therefore
// shows the published close(requests) path and the actor's range loop ending,
// but leaves the test unjudged and does not claim Close synchronously joins.

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
  pass,
  fail,
  recv,
  remake,
  send,
  set,
  wait,
  waitgroup,
} from "../engine/ops.ts";
import type { Op, Program } from "../engine/model.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gen = Generator<Op, void, any>;

const K = {
  accountInitial: { value: 100, file: "check_test.go", text: "account := NewAccount(100)" },
  deposit50: { value: 50, file: "check_test.go", text: "account.Deposit(50)" },
  basicWithdraw: { value: 30, file: "check_test.go", text: "withdrawWithTimeout(t, account, 30)" },
  basicReject: { value: 1000, file: "check_test.go", text: "withdrawWithTimeout(t, account, 1000)" },
  fundsInitial: { value: 100, file: "check_test.go", text: "const initial = 100" },
  fundsAmount: { value: 30, file: "check_test.go", text: "const amount = 30" },
  fundsAttempts: { value: 5, file: "check_test.go", text: "const attempts = 5" },
} as const;

const BASIC_INITIAL = K.accountInitial.value;
const FUNDS_INITIAL = K.fundsInitial.value;
const FUNDS_AMOUNT = K.fundsAmount.value;
const FUNDS_ATTEMPTS = K.fundsAttempts.value;
const FUNDS_MAX_SUCCESSES = Math.floor(FUNDS_INITIAL / FUNDS_AMOUNT);

const tests = {
  basic: { name: "TestAccountBasicOperations", short: "seven calls" },
  funds: { name: "TestAccountWithdrawRejectsInsufficientFunds", short: "withdrawals" },
} as const;

const directWithdraw: Program = function* ({ vars }) {
  yield inc("balance", -FUNDS_AMOUNT, { at: "a.balance = a.balance - amount" });
  vars.successes = (vars.successes ?? 0) + 1;
  yield inc("successes", 1, { at: "return nil" });
  yield done("wg");
};

const actorFunds: Program = function* () {
  let balance = FUNDS_INITIAL;

  for (;;) {
    const req = yield recv("request", { at: "for req := range a.requests" });
    if (!req.ok) return;

    const token = String(req.v);
    if (token === "bal") {
      yield send("balanceReply", balance, { at: "req.reply <- response{balance: balance}" });
      continue;
    }

    const caller = Number(token.slice(1));
    const reply = `reply${caller}`;
    if (req.v === `w${caller}` && balance >= FUNDS_AMOUNT) {
      balance -= FUNDS_AMOUNT;
      yield set("balance", balance, { at: "balance -= req.amount" });
      yield send(reply, null, { at: "req.reply <- response{balance: balance}" });
    } else {
      yield send(reply, "err", { at: "req.reply <- response{balance: balance, err: ErrInsufficientFunds}" });
    }
  }
};

const callersFunds: Program = function* ({ i, vars }) {
  yield send("request", `w${i}`, {
    at: "a.requests <- request{kind: opWithdraw, amount: amount, reply: reply}",
  });
  const response = yield recv(`reply${i}`, { at: "resp := <-reply" });
  if (response.ok && response.v === null) {
    vars.successes = (vars.successes ?? 0) + 1;
    yield inc("successes", 1);
  }
  yield done("wg");
};

const fundsNodes = () => ({
  test: goroutine({
    label: "test",
    pos: [0, 2],
    main: true,
    program: function* ({ vars }): Gen {
      yield go("actor");
      yield add("wg", FUNDS_ATTEMPTS);
      yield go("caller[*]");
      yield wait("wg");

      yield remake("balanceReply");
      yield send("request", "bal");
      const response = yield recv("balanceReply");
      const balance = Number(response.v);
      vars.balance = balance;
      if (
        balance === FUNDS_INITIAL - FUNDS_AMOUNT * FUNDS_MAX_SUCCESSES &&
        (vars.successes ?? 0) === FUNDS_MAX_SUCCESSES
      ) {
        yield pass("funds");
      } else {
        yield fail("funds");
      }
    },
  }),
  wg: waitgroup({ label: "wg", pos: [0, 3] }),
  caller: goroutine({
    label: "caller",
    pos: [1, 2],
    count: FUNDS_ATTEMPTS,
    spawned: true,
    program: callersFunds,
  }),
  request: channel({ label: "request", pos: [2, 2], cap: 0 }),
  actor: goroutine({
    label: "actor",
    pos: [3, 2],
    spawned: true,
    program: actorFunds,
  }),
  balance: fact({ label: "balance", pos: [3, 0], value: FUNDS_INITIAL }),
  reply0: channel({ label: "reply-0", pos: [4, 0], cap: 0 }),
  reply1: channel({ label: "reply-1", pos: [4, 1], cap: 0 }),
  reply2: channel({ label: "reply-2", pos: [4, 2], cap: 0 }),
  reply3: channel({ label: "reply-3", pos: [4, 3], cap: 0 }),
  reply4: channel({ label: "reply-4", pos: [4, 4], cap: 0 }),
  successes: fact({ label: "successes", pos: [5, 1], value: 0, limit: FUNDS_MAX_SUCCESSES }),
  balanceReply: channel({ label: "reply", pos: [5, 3], cap: 0 }),
});

const ACTOR_LOOP = `
@actor func (a *Account) run(balance int) {
@actor 	for req := range a.requests {
@actor 		switch req.kind {
@actor 		case opDeposit:
@actor 			balance += req.amount
@actor 			req.reply <- response{balance: balance}
@actor 		case opWithdraw:
@actor 			if req.amount > balance {
@actor 				req.reply <- response{balance: balance, err: ErrInsufficientFunds}
@actor 				continue
@actor 			}
@actor 			balance -= req.amount
@actor 			req.reply <- response{balance: balance}
@actor 		case opBalance:
@actor 			req.reply <- response{balance: balance}
@actor 		}
@actor 	}
@actor }`;

const SERIAL_TEST = `
@test func (a *Account) Deposit(amount int) {
@test 	reply := make(chan response)
@test 	a.requests <- request{kind: opDeposit, amount: amount, reply: reply}
@test 	<-reply
@test }
…
@test func (a *Account) Balance() int {
@test 	reply := make(chan response)
@test 	a.requests <- request{kind: opBalance, reply: reply}
@test 	resp := <-reply
@test 	return resp.balance
@test }`;

const WITHDRAW_TEST = `
@caller func (a *Account) Withdraw(amount int) error {
@caller 	reply := make(chan response)
@caller 	a.requests <- request{kind: opWithdraw, amount: amount, reply: reply}
@caller 	resp := <-reply
@caller 	return resp.err
@caller }`;

const SERIAL_WITHDRAW_TEST = `
@test func (a *Account) Withdraw(amount int) error {
@test 	reply := make(chan response)
@test 	a.requests <- request{kind: opWithdraw, amount: amount, reply: reply}
@test 	resp := <-reply
@test 	return resp.err
@test }`;

const CLOSE_TEST = `
@test func (a *Account) Close() {
@test 	close(a.requests)
@test }`;

export default defineViz({
  schema: 3,
  exercise: "19-actor-model",
  diagrams: { today: "fnv1a:5281e0c0", goal: "fnv1a:5281e0c0" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: "This animation shows five withdrawals with no funds check. The balance goes below zero. It does not model one exact read/write race.",
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 1],
            main: true,
            program: function* ({ vars }): Gen {
              yield add("wg", FUNDS_ATTEMPTS);
              yield go("caller[*]");
              yield wait("wg");
              if ((vars.successes ?? 0) === FUNDS_ATTEMPTS) {
                yield fail("funds");
              } else {
                yield pass("funds");
              }
            },
          }),
          wg: waitgroup({ label: "wg", pos: [0, 2] }),
          caller: goroutine({
            label: "caller",
            pos: [1, 1],
            count: FUNDS_ATTEMPTS,
            spawned: true,
            program: directWithdraw,
          }),
          balance: fact({ label: "balance", pos: [2, 0], value: FUNDS_INITIAL }),
          successes: fact({ label: "successes", pos: [2, 2], value: 0, limit: FUNDS_MAX_SUCCESSES }),
        },
        insight: `The test rejects this outcome. Five withdrawals each subtract ${FUNDS_AMOUNT} and return nil. The balance ends at ${FUNDS_INITIAL - FUNDS_AMOUNT * FUNDS_ATTEMPTS}. This is not one exact order of unsynchronized reads and writes.`,
        stops: [
          {
            when: { op: "inc", node: "balance", nth: FUNDS_MAX_SUCCESSES + 1 },
            say: "A fourth withdrawal succeeds with no funds check. The balance goes below zero. Withdraw still returns nil.",
          },
        ],
        tests: { funds: tests.funds },
        code: {
          file: "main.go",
          text: `
@test func NewAccount(initial int) *Account {
@test 	return &Account{balance: initial}
@test }
…
@caller func (a *Account) Withdraw(amount int) error {
@caller 	a.balance = a.balance - amount
@caller 	return nil
@caller }`,
        },
        expect: { outcome: "ok", tests: { funds: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: "Five withdrawals reach one actor. It handles them one at a time. Each reply goes to its caller's own channel.",
      model: {
        nodes: fundsNodes(),
        insight: `Only the actor reads or writes the balance. It handles one request at a time. Three withdrawals take ${FUNDS_AMOUNT} each. The last two get ErrInsufficientFunds. The balance is ${FUNDS_INITIAL - FUNDS_AMOUNT * FUNDS_MAX_SUCCESSES}. This test never closes the account, so the actor stays blocked.`,
        stops: [
          {
            when: { op: "set", node: "balance" },
            say: `The first withdrawal moves ${FUNDS_INITIAL} to ${FUNDS_INITIAL - FUNDS_AMOUNT}. No other request can run inside this check and debit.`,
          },
          {
            when: { op: "set", node: "balance", nth: FUNDS_MAX_SUCCESSES - 1 },
            say: `The third debit leaves ${FUNDS_INITIAL - FUNDS_AMOUNT * FUNDS_MAX_SUCCESSES}. Both remaining withdrawals must now fail.`,
          },
          {
            when: { op: "send", g: "actor", node: "balanceReply" },
            say: `The final Balance call reports ${FUNDS_INITIAL - FUNDS_AMOUNT * FUNDS_MAX_SUCCESSES}. successes stops at ${FUNDS_MAX_SUCCESSES}.`,
          },
        ],
        tests: { funds: tests.funds },
        expect: { outcome: "leak", tests: { funds: "pass" } },
      },
    },
    {
      id: "serial",
      chip: "Serial",
      tier: "inside",
      summary: "This shows the seven calls in TestAccountBasicOperations. Each call sends one request and waits for one reply.",
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 1],
            main: true,
            program: function* ({ vars }): Gen {
              let bad = false;
              yield go("actor");

              yield remake("reply");
              yield send("requests", "bal", {
                at: "a.requests <- request{kind: opBalance, reply: reply}",
              });
              let response = yield recv("reply", { at: "resp := <-reply" });
              if (Number(response.v) !== BASIC_INITIAL) bad = true;

              yield remake("reply");
              yield send("requests", "dep", {
                at: "a.requests <- request{kind: opDeposit, amount: amount, reply: reply}",
              });
              response = yield recv("reply", { at: "<-reply" });
              if (Number(response.v) !== BASIC_INITIAL + K.deposit50.value) bad = true;

              yield remake("reply");
              yield send("requests", "bal", {
                at: "a.requests <- request{kind: opBalance, reply: reply}",
              });
              response = yield recv("reply", { at: "resp := <-reply" });
              if (Number(response.v) !== BASIC_INITIAL + K.deposit50.value) bad = true;

              yield remake("reply");
              yield send("requests", "w30", { at: "a.requests <- request{kind: opWithdraw, amount: amount, reply: reply}" });
              response = yield recv("reply", { at: "resp := <-reply" });
              if (response.v !== null) bad = true;

              yield remake("reply");
              yield send("requests", "bal", { at: "a.requests <- request{kind: opBalance, reply: reply}" });
              response = yield recv("reply", { at: "resp := <-reply" });
              if (Number(response.v) !== BASIC_INITIAL + K.deposit50.value - K.basicWithdraw.value) bad = true;

              yield remake("reply");
              yield send("requests", "w1k", { at: "a.requests <- request{kind: opWithdraw, amount: amount, reply: reply}" });
              response = yield recv("reply", { at: "resp := <-reply" });
              if (response.v !== "err") bad = true;

              yield remake("reply");
              yield send("requests", "bal", { at: "a.requests <- request{kind: opBalance, reply: reply}" });
              response = yield recv("reply", { at: "resp := <-reply" });
              if (Number(response.v) !== BASIC_INITIAL + K.deposit50.value - K.basicWithdraw.value) bad = true;

              vars.bad = bad ? 1 : 0;
              if (bad) yield fail("basic");
              else yield pass("basic");
            },
          }),
          requests: channel({ label: "requests", pos: [1, 1], cap: 0 }),
          reply: channel({ label: "reply channel", pos: [2, 1], cap: 0 }),
          actor: goroutine({
            label: "actor",
            pos: [3, 1],
            spawned: true,
            program: function* (): Gen {
              let balance = BASIC_INITIAL;

              for (;;) {
                const request = yield recv("requests", { at: "for req := range a.requests" });
                if (!request.ok) return;

                switch (request.v) {
                  case "dep":
                    balance += K.deposit50.value;
                    yield set("balance", balance, { at: "balance += req.amount" });
                    yield send("reply", balance, { at: "req.reply <- response{balance: balance}" });
                    break;
                  case "w30":
                    balance -= K.basicWithdraw.value;
                    yield set("balance", balance, { at: "balance -= req.amount" });
                    yield send("reply", null, { at: "req.reply <- response{balance: balance}" });
                    break;
                  case "w1k":
                    if (K.basicReject.value > balance) {
                      yield send("reply", "err", {
                        at: "req.reply <- response{balance: balance, err: ErrInsufficientFunds}",
                      });
                    } else {
                      balance -= K.basicReject.value;
                      yield set("balance", balance, { at: "balance -= req.amount" });
                      yield send("reply", null, { at: "req.reply <- response{balance: balance}" });
                    }
                    break;
                  case "bal":
                    yield send("reply", balance, { at: "req.reply <- response{balance: balance}" });
                    break;
                }
              }
            },
          }),
          balance: fact({ label: "balance", pos: [3, 0], value: BASIC_INITIAL }),
        },
        insight: `All seven calls pass through one actor in order. Balance starts at 100. Deposit 50 raises it to 150. Withdraw 30 lowers it to 120. The 1000 withdrawal is rejected. Balance stays at 120. Each reply uses that call's channel. The actor is still blocked when the test returns.`,
        stops: [
          { when: { op: "send", g: "test", node: "requests" }, say: "A method sends its request. It then waits on its own reply channel." },
          { when: { op: "send", g: "actor", node: "reply" }, say: "The actor sends the result. It handles the next request only after this one." },
          { when: { op: "recv", g: "actor", node: "requests", nth: 7 }, say: "All seven calls are done, in order. The actor now waits for another request." },
        ],
        tests: { basic: tests.basic },
        code: { file: "solution", text: `${SERIAL_TEST}\n…\n${SERIAL_WITHDRAW_TEST}\n…\n${ACTOR_LOOP}` },
        expect: { outcome: "leak", tests: { basic: "pass" } },
      },
    },
    {
      id: "funds",
      chip: "Funds",
      tier: "inside",
      summary: "The actor checks and debits in one step. Two concurrent withdrawals cannot spend the same funds.",
      model: {
        nodes: fundsNodes(),
        insight: `Five callers wait on five reply channels. The actor takes one request at a time. It compares ${FUNDS_AMOUNT} with the balance, then debits. Three requests fit. Two get ErrInsufficientFunds and leave ${FUNDS_INITIAL - FUNDS_AMOUNT * FUNDS_MAX_SUCCESSES} unchanged.`,
        stops: [
          {
            when: { op: "set", node: "balance" },
            say: `The actor checks ${FUNDS_AMOUNT} against ${FUNDS_INITIAL}. It then debits to ${FUNDS_INITIAL - FUNDS_AMOUNT}. No other request can run between those steps.`,
          },
          {
            when: { op: "set", node: "balance", nth: FUNDS_MAX_SUCCESSES - 1 },
            say: `After three successful withdrawals, the balance is ${FUNDS_INITIAL - FUNDS_AMOUNT * FUNDS_MAX_SUCCESSES}. The actor rejects both remaining withdrawals without changing it.`,
          },
          {
            when: { op: "send", g: "actor", node: "balanceReply" },
            say: `The final Balance call reads ${FUNDS_INITIAL - FUNDS_AMOUNT * FUNDS_MAX_SUCCESSES}. Three callers reported success.`,
          },
        ],
        tests: { funds: tests.funds },
        code: { file: "solution", text: `${WITHDRAW_TEST}\n…\n${ACTOR_LOOP}` },
        expect: { outcome: "leak", tests: { funds: "pass" } },
      },
    },
    {
      id: "close",
      chip: "Close",
      tier: "inside",
      summary: "Close closes the request channel. The actor's range loop ends. The actor goroutine returns.",
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 1],
            main: true,
            program: function* (): Gen {
              yield go("actor");

              yield remake("reply");
              yield send("requests", "dep", {
                at: "a.requests <- request{kind: opDeposit, amount: amount, reply: reply}",
              });
              yield recv("reply", { at: "<-reply" });

              yield remake("reply");
              yield send("requests", "bal", {
                at: "a.requests <- request{kind: opBalance, reply: reply}",
              });
              const response = yield recv("reply", { at: "resp := <-reply" });
              if (Number(response.v) !== BASIC_INITIAL + K.deposit50.value) return;

              yield close("requests", { at: "close(a.requests)" });
            },
          }),
          requests: channel({ label: "requests", pos: [1, 1], cap: 0 }),
          reply: channel({ label: "reply", pos: [1, 2], cap: 0 }),
          actor: goroutine({
            label: "actor",
            pos: [2, 1],
            spawned: true,
            program: function* (): Gen {
              let balance = BASIC_INITIAL;

              for (;;) {
                const request = yield recv("requests", { at: "for req := range a.requests" });
                if (!request.ok) return;

                if (request.v === "dep") {
                  balance += K.deposit50.value;
                  yield set("balance", balance, { at: "balance += req.amount" });
                  yield send("reply", balance, { at: "req.reply <- response{balance: balance}" });
                } else {
                  yield send("reply", balance, { at: "req.reply <- response{balance: balance}" });
                }
              }
            },
          }),
          balance: fact({ label: "balance", pos: [2, 0], value: BASIC_INITIAL }),
        },
        insight: `Closing requests ends the actor's range receive. The actor returns after the deposit and Balance call. The published Close has no separate join signal. So this scene is unjudged and does not claim Close waits.`,
        stops: [
          { when: { op: "close", node: "requests" }, say: "Close closes the request channel. It is not safe to send another request." },
          { when: { op: "return", g: "actor" }, say: "The actor's range loop ends. The long-lived actor goroutine exits." },
        ],
        code: { file: "solution", text: `${SERIAL_TEST}\n…\n${CLOSE_TEST}\n…\n${ACTOR_LOOP}` },
        expect: { outcome: "ok" },
      },
    },
  ],
});
