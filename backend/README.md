# Reclaim — AI Revenue Recovery Agent

Resolves ambiguous/contradictory Razorpay payment webhooks (duplicates,
out-of-order events, delayed success after a reported failure) using a
deterministic guardrail state machine, with an AI layer constrained to
recommending one of four safe actions.

## Setup
```
cd backend
npm install
cp .env.example .env   # fill in your real Razorpay test-mode + Anthropic keys
```

## Run the unit tests (resolver logic, no server needed)
```
node src/resolver.test.js
```

## Run the batch correctness test (50 synthetic scenarios)
```
npm run test:batch
```

## Run the actual server
```
npm start
```
Expose it with ngrok and point your Razorpay test-mode webhook at:
`https://<your-ngrok-url>/webhook/razorpay`

## API endpoints (for the frontend)
- `GET  /api/cases` — list all cases
- `GET  /api/cases/:orderId` — one case's full event + audit history
- `POST /api/simulate-event` — fire a fake event without a real signed webhook (for demos)

## What's real vs simulated
The resolver, signature verification, and case state machine run on real logic
and can process real Razorpay test-mode webhooks. The `/api/simulate-event`
endpoint exists specifically so out-of-order/duplicate/race-condition scenarios
can be demonstrated live without depending on unreliable real-world timing.

## Known limitations
- In-memory case store — state does not survive a server restart. Swap
  CaseStore's internals for Postgres/Mongo before any real deployment.
- No locking around concurrent webhooks for the same order_id — a true
  race (two events processed in the same millisecond) is not yet guarded.
- AI recommendation layer requires GROQ_API_KEY; without it, the
  system safely defaults to REQUEST_MERCHANT_REVIEW rather than guessing.
