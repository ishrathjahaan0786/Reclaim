# Reclaim — Deterministic Payment State Resolver for Razorpay Webhooks

Razorpay's own webhook documentation acknowledges that delivery is not guaranteed to be ordered, deduplicated, or timely. In production, that means a merchant's system can receive a `failed` event before the real `captured` event, receive the same event twice, or never receive a confirming second event at all.

Most integrations react to the first signal they see. That's how merchants refund payments that actually succeeded, or ask customers to pay twice for something already paid for.

**Reclaim is a state machine that refuses to do that.** It never trusts a single webhook in isolation — it waits, verifies against Razorpay's own API when a webhook can't be trusted, and locks every resolved decision so no later, contradictory signal can reopen it.

## Why this exists (not simulated — tested against real Razorpay behavior)

This project started from reading Razorpay's webhook reliability docs and asking: what does a resolver look like that is *provably* correct under every failure mode they describe, not just the happy path?

The `SUCCESS_LATE` case in the demo isn't scripted — it's a real Razorpay test-mode payment that initially reported `failed`, then reported `captured` seconds later on the same order. Reclaim's wait-window logic caught that and confirmed the order with zero incorrect money movement.

## Architecture

```
backend/
  src/
    resolver.js          # the core state machine — all money-safety logic lives here
    resolver.test.js      # dependency-free unit tests, run anywhere in <1s
    caseStore.js          # case state persistence (JSON-backed, swappable)
    webhookVerify.js       # HMAC signature verification on raw request body
    aiRecommendation.js    # constrained AI layer — recommends, never decides
    batchTest.js           # 50-scenario correctness harness
    routes/                # API endpoints
  server.js
frontend/
  index.html               # zero-build dashboard, no framework, no bundler
```

**Design principle:** the resolver is the only thing allowed to touch money-relevant state. The AI layer is downstream of it, constrained to recommending one of four pre-defined safe actions, and every recommendation is checked by a deterministic validator before it can be surfaced. The AI cannot move money and cannot bypass the state machine.

## What's actually enforced (not marketing copy — this is what `resolver.js` does)

- **Terminal states are never reopened.** Once an order is `SUCCESS` or `SUCCESS_LATE`, no later `failed` webhook can undo it.
- **A `failed` signal is never trusted immediately.** It opens a wait window instead of acting, because Razorpay's docs confirm a delayed success can still arrive.
- **Ground truth is polled directly from Razorpay's API** when a webhook can't be trusted — the resolver does not sit around hoping a second webhook shows up, because Razorpay's own documentation says it might not.
- **Unhandled event types escalate to a human** (`REQUEST_MERCHANT_REVIEW`) instead of guessing.
- **Signature verification runs on the raw, unparsed request body** — computing it after JSON parsing/re-serialization silently breaks Razorpay's HMAC check, which is a real bug I hit and fixed during development (see commit history).

## Correctness evidence

```
npm run test:batch
```

runs 50 synthetic edge cases — duplicate events, out-of-order delivery, `failed`-then-late-`success` races — end to end through the actual resolver code in this repo. Current result: **50/50 resolved correctly, zero incorrect money actions.** This isn't a claimed number; it's the output of code you can run yourself in under a second.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # fill in your Razorpay test-mode keys + GROQ_API_KEY
```

Run the unit tests (resolver logic only, no server needed):
```bash
node src/resolver.test.js
```

Run the 50-scenario correctness suite:
```bash
npm run test:batch
```

Run the server:
```bash
npm start
```

Expose it for real Razorpay test-mode webhooks:
```bash
ngrok http <port>
# point your Razorpay test-mode webhook at https://<your-ngrok-url>/webhook/razorpay
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/cases` | List all cases |
| `GET /api/cases/:orderId` | Full event + audit history for one case |
| `POST /api/simulate-event` | Fire an unsigned synthetic event, for demoing race conditions without depending on real-world webhook timing |

## What's real vs. what's simulated

The resolver, signature verification, and state machine run identical logic whether the event came from a real signed Razorpay webhook or from `/api/simulate-event`. The simulate endpoint exists because real out-of-order/duplicate timing from Razorpay's test mode is not reliably reproducible on demand — the underlying decision logic being exercised is the same either way.

## Known limitations (and why they're not fixed yet)

I'd rather ship something smaller that I can fully defend than something larger I can't. Specifically, not yet handled:

- **In-memory/JSON case store** — state doesn't survive a restart. `CaseStore`'s internals are isolated behind a small interface specifically so swapping in Postgres/Mongo doesn't touch resolver logic.
- **No lock around concurrent webhooks for the same `order_id`** — two events landing in the same millisecond for one order isn't guarded yet. This is the next correctness gap I'd close before any real deployment.
- **AI layer degrades safely, not silently** — without `GROQ_API_KEY` set, the system defaults to `REQUEST_MERCHANT_REVIEW` rather than guessing or failing.

## Stack

Node.js, Express, Groq (single constrained recommendation step), vanilla JS dashboard (no build step), real Razorpay test-mode APIs.
