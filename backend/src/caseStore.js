/**
 * PaymentCase store.
 *
 * IMPORTANT: keyed by order_id, NOT payment_id. A recovery payment
 * link generates a brand new payment_id for a retry attempt on the
 * SAME order. If we keyed by payment_id, the resolver would have no
 * memory that a retry belongs to an order that already has an
 * outstanding recovery link — which is exactly the guardrail this
 * whole system exists to enforce.
 *
 * This is an in-memory Map for the demo. Swap this module's internals
 * for a real database (Postgres/Mongo) before going anywhere near
 * production — state must survive a server restart.
 */

const STATES = Object.freeze({
  NEW: "NEW",
  WAIT_WINDOW: "WAIT_WINDOW",
  SUCCESS: "SUCCESS",
  SUCCESS_LATE: "SUCCESS_LATE",
  FAILED: "FAILED",
  UNCERTAIN: "UNCERTAIN",
});

// Terminal states can never be reopened by a later event, no matter
// what that event says. This protects BOTH plain success and
// late-success — a common bug is protecting only SUCCESS and leaving
// SUCCESS_LATE reopenable by a stray noisy failure webhook.
const TERMINAL_STATES = new Set([STATES.SUCCESS, STATES.SUCCESS_LATE]);

class CaseStore {
  constructor() {
    this.casesByOrderId = new Map();
    this.seenEventIds = new Set();
  }

  hasSeenEvent(eventId) {
    return this.seenEventIds.has(eventId);
  }

  markEventSeen(eventId) {
    this.seenEventIds.add(eventId);
  }

  getOrCreateCase(orderId) {
    if (!this.casesByOrderId.has(orderId)) {
      this.casesByOrderId.set(orderId, {
        orderId,
        state: STATES.NEW,
        events: [], // raw events received, in arrival order
        auditLog: [], // { timestamp, factsSeen, ruleApplied, decision, reasoning }
        recoveryLinkSent: false, // one unresolved recovery ask at a time
        waitWindowExpiresAt: null,
        paymentIds: new Set(), // every payment_id attempt tied to this order
      });
    }
    return this.casesByOrderId.get(orderId);
  }

  isTerminal(caseObj) {
    return TERMINAL_STATES.has(caseObj.state);
  }

  appendAudit(caseObj, entry) {
    caseObj.auditLog.push({
      timestamp: new Date().toISOString(),
      ...entry,
    });
  }

  getAllCases() {
    return Array.from(this.casesByOrderId.values());
  }

  getCase(orderId) {
    return this.casesByOrderId.get(orderId) || null;
  }

  reset() {
    this.casesByOrderId.clear();
    this.seenEventIds.clear();
  }
}

module.exports = { CaseStore, STATES, TERMINAL_STATES };
