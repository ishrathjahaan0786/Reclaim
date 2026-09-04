const { STATES } = require("./caseStore");

// How long to wait after a "failed" signal before trusting it, in ms.
// In the demo this is short (e.g. 10s) so you can show it live.
// In production this should be minutes, tuned against how long
// Razorpay's acquiring-bank retries typically take to resolve.
const WAIT_WINDOW_MS = Number(process.env.WAIT_WINDOW_MS || 10000);

/**
 * resolve() is a PURE function: given a case's current state and one
 * incoming event, it returns what should happen next. It does not
 * touch the database, the network, or the clock beyond reading
 * Date.now() for wait-window math. This makes it trivially unit
 * testable without any server running — which is exactly how you
 * prove correctness before wiring up real I/O.
 *
 * @param {object} caseObj - the current PaymentCase (read-only here)
 * @param {object} event - normalized event: { type, paymentId, occurredAt }
 *   type is one of: 'captured' | 'failed' | 'unknown'
 * @returns {{ newState: string, action: string, reasoning: string }}
 */
function resolve(caseObj, event) {
  // Terminal states are locked. Nothing reopens them — this is the
  // fix for the bug where a stray late "failed" webhook could flip
  // a SUCCESS_LATE case back to FAILED.
  if (caseObj.state === STATES.SUCCESS || caseObj.state === STATES.SUCCESS_LATE) {
    return {
      newState: caseObj.state,
      action: "NONE_ALREADY_TERMINAL",
      reasoning: `Case is already ${caseObj.state}. Ignoring incoming '${event.type}' event as noise — terminal states are never reopened.`,
    };
  }

  if (event.type === "captured") {
    // Success is unambiguous — but check history for a prior failure
    // signal. If this order previously looked FAILED (or was mid
    // wait-window), this is a "late success": the exact moment a
    // merchant might have already refunded or retried by mistake.
    const previouslyLookedFailed =
      caseObj.state === STATES.FAILED || caseObj.state === STATES.WAIT_WINDOW;

    if (previouslyLookedFailed) {
      return {
        newState: STATES.SUCCESS_LATE,
        action: "CONFIRM_ORDER_NO_REFUND_NO_RECHARGE",
        reasoning:
          "Payment succeeded, but this order previously showed a failure signal. Flagging as late success: confirm the order, do NOT refund and do NOT charge again.",
      };
    }

    return {
      newState: STATES.SUCCESS,
      action: "CONFIRM_ORDER",
      reasoning: "Payment succeeded with no prior contradictory signal. Confirming order.",
    };
  }

  if (event.type === "failed") {
    // Don't believe a failure immediately. Start (or keep) a wait
    // window. Only after the window elapses AND we've polled
    // Razorpay's API for ground truth do we call it truly FAILED.
    // We do NOT wait for a second webhook — one may never arrive.
    if (caseObj.state === STATES.WAIT_WINDOW) {
      return {
        newState: STATES.WAIT_WINDOW,
        action: "NONE_ALREADY_WAITING",
        reasoning: "Already in wait window for this order. Duplicate/second failure signal changes nothing yet.",
      };
    }

    return {
      newState: STATES.WAIT_WINDOW,
      action: "START_WAIT_WINDOW",
      reasoning: `Received a failure signal. Starting a ${WAIT_WINDOW_MS}ms wait window before trusting it, in case a success signal is still in flight.`,
      waitWindowExpiresAt: Date.now() + WAIT_WINDOW_MS,
    };
  }

  // Anything we don't explicitly recognize gets escalated, never
  // guessed at. This is the safety net against edge cases nobody
  // anticipated.
  return {
    newState: STATES.UNCERTAIN,
    action: "REQUEST_MERCHANT_REVIEW",
    reasoning: `Received an event type ('${event.type}') with no matching rule. Escalating to a human instead of guessing.`,
  };
}

/**
 * Called when a case's wait window has elapsed with no success event
 * having arrived. This is where we poll Razorpay's payment-status API
 * directly, rather than hoping a second webhook shows up (it may
 * never come).
 *
 * @param {string} groundTruthStatus - result of the Razorpay API poll:
 *   'captured' | 'failed' | 'unknown'
 */
function resolveAfterWaitWindow(caseObj, groundTruthStatus) {
  if (caseObj.state === STATES.SUCCESS || caseObj.state === STATES.SUCCESS_LATE) {
    return {
      newState: caseObj.state,
      action: "NONE_ALREADY_TERMINAL",
      reasoning: "Case resolved to a terminal success state before the wait window ended. Nothing to do.",
    };
  }

  if (groundTruthStatus === "captured") {
    return {
      newState: STATES.SUCCESS_LATE,
      action: "CONFIRM_ORDER_NO_REFUND_NO_RECHARGE",
      reasoning: "Wait window elapsed. Polled Razorpay directly and found the payment actually succeeded. Confirming order, no refund, no recharge.",
    };
  }

  if (groundTruthStatus === "failed") {
    return {
      newState: STATES.FAILED,
      action: caseObj.recoveryLinkSent ? "NONE_LINK_ALREADY_PENDING" : "PREPARE_ONE_RECOVERY_LINK",
      reasoning: caseObj.recoveryLinkSent
        ? "Payment confirmed failed. A recovery link is already pending for this order — not sending a second one."
        : "Wait window elapsed. Polled Razorpay directly and confirmed the payment truly failed. Preparing one recovery link suggestion for merchant approval.",
    };
  }

  return {
    newState: STATES.UNCERTAIN,
    action: "REQUEST_MERCHANT_REVIEW",
    reasoning: `Wait window elapsed but Razorpay's API returned an unrecognized status ('${groundTruthStatus}'). Escalating to a human.`,
  };
}

module.exports = { resolve, resolveAfterWaitWindow, WAIT_WINDOW_MS };
