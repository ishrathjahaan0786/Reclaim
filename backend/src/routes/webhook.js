const express = require("express");
const { verifyRazorpaySignature } = require("../webhookVerify");
const { STATES } = require("../caseStore");
const { resolve, resolveAfterWaitWindow, WAIT_WINDOW_MS } = require("../resolver");

function normalizeEventType(razorpayEvent) {
  if (razorpayEvent === "payment.captured") return "captured";
  if (razorpayEvent === "payment.failed") return "failed";
  return "unknown";
}

function buildWebhookRouter({ caseStore, razorpayClient, webhookSecret }) {
  const router = express.Router();

  // NOTE: this route must receive the RAW body, not pre-parsed JSON,
  // because signature verification is computed over the exact raw
  // bytes Razorpay sent. See server.js for the raw-body middleware
  // applied specifically to this path.
  router.post("/webhook/razorpay", async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.rawBody;

    const isValid = verifyRazorpaySignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      // Reject BEFORE any business logic touches this request. This
      // is the fix for the "anyone could fake a webhook" hole.
      return res.status(400).json({ error: "invalid signature" });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "invalid JSON body" });
    }

    const eventId = payload.id || req.headers["x-razorpay-event-id"];
    const razorpayEventType = payload.event;
    const paymentEntity = payload?.payload?.payment?.entity;
    const orderId = paymentEntity?.order_id || paymentEntity?.id; // fall back if order_id missing
    const paymentId = paymentEntity?.id;

    if (!orderId) {
      return res.status(400).json({ error: "no order_id found in payload" });
    }

    // Idempotency: Razorpay uses at-least-once delivery, so the same
    // event can arrive more than once. A repeat does nothing.
    if (eventId && caseStore.hasSeenEvent(eventId)) {
      return res.status(200).json({ status: "duplicate event ignored" });
    }
    if (eventId) caseStore.markEventSeen(eventId);

    const caseObj = caseStore.getOrCreateCase(orderId);
    if (paymentId) caseObj.paymentIds.add(paymentId);
    caseObj.events.push({ eventId, razorpayEventType, paymentId, receivedAt: new Date().toISOString() });

    const normalizedType = normalizeEventType(razorpayEventType);
    const result = resolve(caseObj, { type: normalizedType });

    caseObj.state = result.newState;
    if (result.action === "PREPARE_ONE_RECOVERY_LINK") caseObj.recoveryLinkSent = true;
    if (result.waitWindowExpiresAt) caseObj.waitWindowExpiresAt = result.waitWindowExpiresAt;

    caseStore.appendAudit(caseObj, {
      factsSeen: { razorpayEventType, paymentId, eventId },
      ruleApplied: "resolve()",
      decision: result.action,
      reasoning: result.reasoning,
    });

    // If we just entered WAIT_WINDOW, schedule the ground-truth poll.
    // We do NOT wait for a second webhook — we go ask Razorpay
    // directly once the window elapses, since a second webhook may
    // never arrive.
    if (result.newState === STATES.WAIT_WINDOW) {
      scheduleGroundTruthCheck({ caseStore, razorpayClient, orderId, paymentId });
    }

    return res.status(200).json({ status: "processed", state: caseObj.state, action: result.action });
  });

  return router;
}

function scheduleGroundTruthCheck({ caseStore, razorpayClient, orderId, paymentId }) {
  setTimeout(async () => {
    const caseObj = caseStore.getCase(orderId);
    if (!caseObj || caseObj.state !== STATES.WAIT_WINDOW) return; // already resolved by a later event

    let groundTruthStatus = "unknown";
    try {
      // Poll Razorpay directly for the real status rather than
      // trusting silence or hoping for a second webhook.
      const payment = await razorpayClient.payments.fetch(paymentId);
      groundTruthStatus = payment.status === "captured" ? "captured" : payment.status === "failed" ? "failed" : "unknown";
    } catch (err) {
      groundTruthStatus = "unknown";
    }

    const result = resolveAfterWaitWindow(caseObj, groundTruthStatus);
    caseObj.state = result.newState;
    if (result.action === "PREPARE_ONE_RECOVERY_LINK") caseObj.recoveryLinkSent = true;

    caseStore.appendAudit(caseObj, {
      factsSeen: { polledStatus: groundTruthStatus },
      ruleApplied: "resolveAfterWaitWindow()",
      decision: result.action,
      reasoning: result.reasoning,
    });
  }, WAIT_WINDOW_MS + 250); // small buffer past the window
}

module.exports = { buildWebhookRouter, normalizeEventType };
