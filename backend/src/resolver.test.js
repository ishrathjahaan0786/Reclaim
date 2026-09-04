/**
 * Resolver unit tests. Run with: node src/resolver.test.js
 *
 * These are plain assertions, not a test framework — deliberately
 * dependency-free so they run anywhere instantly. Per the build
 * workflow: this file must pass 100% before the resolver is wired
 * into any real webhook/server code.
 */
const assert = require("assert");
const { STATES } = require("./caseStore");
const { resolve, resolveAfterWaitWindow } = require("./resolver");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

function freshCase(state = STATES.NEW, overrides = {}) {
  return { state, recoveryLinkSent: false, ...overrides };
}

console.log("Resolver tests:");

check("new case + captured -> SUCCESS", () => {
  const result = resolve(freshCase(STATES.NEW), { type: "captured" });
  assert.strictEqual(result.newState, STATES.SUCCESS);
  assert.strictEqual(result.action, "CONFIRM_ORDER");
});

check("new case + failed -> WAIT_WINDOW", () => {
  const result = resolve(freshCase(STATES.NEW), { type: "failed" });
  assert.strictEqual(result.newState, STATES.WAIT_WINDOW);
  assert.strictEqual(result.action, "START_WAIT_WINDOW");
});

check("WAIT_WINDOW case + captured -> SUCCESS_LATE, no refund/recharge action", () => {
  const result = resolve(freshCase(STATES.WAIT_WINDOW), { type: "captured" });
  assert.strictEqual(result.newState, STATES.SUCCESS_LATE);
  assert.strictEqual(result.action, "CONFIRM_ORDER_NO_REFUND_NO_RECHARGE");
});

check("FAILED case + captured (very late success) -> SUCCESS_LATE", () => {
  const result = resolve(freshCase(STATES.FAILED), { type: "captured" });
  assert.strictEqual(result.newState, STATES.SUCCESS_LATE);
});

check("SUCCESS case + failed noise -> stays SUCCESS, ignored", () => {
  const result = resolve(freshCase(STATES.SUCCESS), { type: "failed" });
  assert.strictEqual(result.newState, STATES.SUCCESS);
  assert.strictEqual(result.action, "NONE_ALREADY_TERMINAL");
});

check("SUCCESS_LATE case + failed noise -> stays SUCCESS_LATE, ignored (regression guard)", () => {
  // This is the exact bug the original code had: only SUCCESS was
  // protected, so a stray failure could flip SUCCESS_LATE back.
  const result = resolve(freshCase(STATES.SUCCESS_LATE), { type: "failed" });
  assert.strictEqual(result.newState, STATES.SUCCESS_LATE);
  assert.strictEqual(result.action, "NONE_ALREADY_TERMINAL");
});

check("WAIT_WINDOW case + duplicate failed -> stays WAIT_WINDOW, no duplicate action", () => {
  const result = resolve(freshCase(STATES.WAIT_WINDOW), { type: "failed" });
  assert.strictEqual(result.newState, STATES.WAIT_WINDOW);
  assert.strictEqual(result.action, "NONE_ALREADY_WAITING");
});

check("unknown event type -> UNCERTAIN, escalated not guessed", () => {
  const result = resolve(freshCase(STATES.NEW), { type: "refund_initiated" });
  assert.strictEqual(result.newState, STATES.UNCERTAIN);
  assert.strictEqual(result.action, "REQUEST_MERCHANT_REVIEW");
});

check("wait window elapses, API confirms captured -> SUCCESS_LATE", () => {
  const result = resolveAfterWaitWindow(freshCase(STATES.WAIT_WINDOW), "captured");
  assert.strictEqual(result.newState, STATES.SUCCESS_LATE);
});

check("wait window elapses, API confirms failed, no link sent yet -> PREPARE_ONE_RECOVERY_LINK", () => {
  const result = resolveAfterWaitWindow(freshCase(STATES.WAIT_WINDOW), "failed");
  assert.strictEqual(result.newState, STATES.FAILED);
  assert.strictEqual(result.action, "PREPARE_ONE_RECOVERY_LINK");
});

check("wait window elapses, API confirms failed, link ALREADY sent -> no second link", () => {
  const c = freshCase(STATES.WAIT_WINDOW, { recoveryLinkSent: true });
  const result = resolveAfterWaitWindow(c, "failed");
  assert.strictEqual(result.action, "NONE_LINK_ALREADY_PENDING");
});

check("wait window elapses, API returns unrecognized status -> UNCERTAIN", () => {
  const result = resolveAfterWaitWindow(freshCase(STATES.WAIT_WINDOW), "authorized");
  assert.strictEqual(result.newState, STATES.UNCERTAIN);
});

check("terminal SUCCESS never reopened even by resolveAfterWaitWindow", () => {
  const result = resolveAfterWaitWindow(freshCase(STATES.SUCCESS), "failed");
  assert.strictEqual(result.newState, STATES.SUCCESS);
  assert.strictEqual(result.action, "NONE_ALREADY_TERMINAL");
});

console.log(`\n${passed} test(s) passed.`);
