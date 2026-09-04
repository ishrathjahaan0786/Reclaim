const express = require("express");
const { runBatch } = require("../batchTest");

function buildApiRouter({ caseStore }) {
  const router = express.Router();

  // Runs the 50-scenario synthetic batch test on demand and returns
  // the summary, so the dashboard can display the headline
  // correctness numbers live instead of only via the CLI.
  router.get("/batch-test", (req, res) => {
    const summary = runBatch();
    res.json(summary);
  });

  // List all cases (for the case list view)
  router.get("/cases", (req, res) => {
    const cases = caseStore.getAllCases().map((c) => ({
      orderId: c.orderId,
      state: c.state,
      eventCount: c.events.length,
      recoveryLinkSent: c.recoveryLinkSent,
      paymentIds: Array.from(c.paymentIds),
      lastUpdated: c.auditLog.at(-1)?.timestamp || null,
    }));
    res.json({ cases });
  });

  // One case's full detail: events + audit trail (for the case detail view)
  router.get("/cases/:orderId", (req, res) => {
    const caseObj = caseStore.getCase(req.params.orderId);
    if (!caseObj) return res.status(404).json({ error: "case not found" });
    res.json({
      orderId: caseObj.orderId,
      state: caseObj.state,
      events: caseObj.events,
      auditLog: caseObj.auditLog,
      recoveryLinkSent: caseObj.recoveryLinkSent,
      paymentIds: Array.from(caseObj.paymentIds),
    });
  });

  // Demo/testing endpoint: simulate a webhook without needing a real
  // signed Razorpay request. NOT exposed in production — this exists
  // purely so the dashboard can drive the "try to break it" demo
  // moment (duplicate events, out-of-order events, unknown events)
  // without needing live Razorpay traffic on stage.
  router.post("/simulate-event", (req, res) => {
    const { orderId, paymentId, eventType, eventId } = req.body;
    if (!orderId || !eventType) {
      return res.status(400).json({ error: "orderId and eventType are required" });
    }

    const { resolve } = require("../resolver");
    const generatedEventId = eventId || `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (caseStore.hasSeenEvent(generatedEventId)) {
      return res.json({ status: "duplicate event ignored" });
    }
    caseStore.markEventSeen(generatedEventId);

    const caseObj = caseStore.getOrCreateCase(orderId);
    if (paymentId) caseObj.paymentIds.add(paymentId);
    caseObj.events.push({ eventId: generatedEventId, razorpayEventType: `simulated.${eventType}`, paymentId, receivedAt: new Date().toISOString() });

    const result = resolve(caseObj, { type: eventType });
    caseObj.state = result.newState;
    if (result.action === "PREPARE_ONE_RECOVERY_LINK") caseObj.recoveryLinkSent = true;

    caseStore.appendAudit(caseObj, {
      factsSeen: { simulatedEventType: eventType, paymentId },
      ruleApplied: "resolve() [simulated]",
      decision: result.action,
      reasoning: result.reasoning,
    });

    res.json({ status: "processed", state: caseObj.state, action: result.action, reasoning: result.reasoning });
  });

  return router;
}

module.exports = { buildApiRouter };
