require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const { CaseStore } = require("./caseStore");
const { buildWebhookRouter } = require("./routes/webhook");
const { buildApiRouter } = require("./routes/api");

const app = express();
const PORT = process.env.PORT || 4000;

const caseStore = new CaseStore();
const razorpayClient = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.use(cors());

// The webhook route needs the RAW request body (exact bytes) to
// verify Razorpay's signature correctly — parsing it to JSON first
// and re-serializing would change the bytes and break verification.
// So we capture rawBody only on this specific path, and use normal
// JSON parsing everywhere else.
app.use(
  "/webhook",
  express.raw({ type: "*/*" }),
  (req, res, next) => {
    req.rawBody = req.body.toString("utf8");
    next();
  }
);

app.use(express.json());

app.use("/", buildWebhookRouter({
  caseStore,
  razorpayClient,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
}));

app.use("/api", buildApiRouter({ caseStore }));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Reclaim backend listening on port ${PORT}`);
  console.log(`Webhook URL to expose via ngrok: http://localhost:${PORT}/webhook/razorpay`);
});
