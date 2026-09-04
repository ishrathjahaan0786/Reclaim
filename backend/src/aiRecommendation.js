const ALLOWED_ACTIONS = Object.freeze([
  "WAIT",
  "CONFIRM_ORDER",
  "REQUEST_MERCHANT_REVIEW",
  "PREPARE_ONE_RECOVERY_LINK",
]);

/**
 * Asks the LLM to recommend exactly one action from a fixed list,
 * plus a short customer/merchant-facing message draft. The AI never
 * refunds, charges, sends anything, or creates links on its own —
 * it only recommends, and recommend() below re-validates the pick
 * against the resolver's own ground truth before anything happens.
 */
async function getAIRecommendation({ orderId, failureReason, orderValue, customerHistorySummary, language = "English/Hinglish" }) {
  // Using Groq's free-tier API (OpenAI-compatible chat completions
  // endpoint). Swap GROQ_API_KEY / model name below if you switch
  // providers later — the rest of this file (the allowed-action list
  // and the deterministic validator) doesn't need to change either way.
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    // Fail safe, not silent: if the AI is unreachable, default to
    // the most conservative allowed action rather than guessing.
    return {
      action: "REQUEST_MERCHANT_REVIEW",
      message: null,
      reasoning: "AI recommendation unavailable (no API key configured). Defaulting to human review.",
    };
  }

  const systemPrompt = `You are a constrained recommendation assistant for a payment recovery system.
You may ONLY choose one action from this exact list: ${ALLOWED_ACTIONS.join(", ")}.
You never decide to move money. You never guarantee outcomes. You draft a short, honest message a human will review before sending.
Respond ONLY with JSON, no preamble, no markdown fences, in this exact shape:
{"action": "<one of the allowed actions>", "message": "<short draft message in ${language}>", "reasoning": "<one sentence why>"}`;

  const userPrompt = `Order ${orderId} failed payment.
Failure reason: ${failureReason || "unknown"}
Order value: ${orderValue || "unknown"}
Customer history: ${customerHistorySummary || "no prior history available"}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const data = await response.json();
  const rawText = data?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      action: "REQUEST_MERCHANT_REVIEW",
      message: null,
      reasoning: "AI response could not be parsed as valid JSON. Defaulting to human review rather than guessing.",
    };
  }

  return validateAIRecommendation(parsed);
}

/**
 * Deterministic validator. The AI's pick is NEVER trusted directly —
 * it must pass this check first. This is the boundary that keeps the
 * AI's role to "recommend wording" and nothing more.
 */
function validateAIRecommendation(parsed) {
  if (!parsed || !ALLOWED_ACTIONS.includes(parsed.action)) {
    return {
      action: "REQUEST_MERCHANT_REVIEW",
      message: null,
      reasoning: `AI proposed an action outside the allowed list ('${parsed?.action}'). Overridden to human review.`,
      overridden: true,
    };
  }
  return {
    action: parsed.action,
    message: typeof parsed.message === "string" ? parsed.message : null,
    reasoning: parsed.reasoning || "No reasoning provided.",
    overridden: false,
  };
}

module.exports = { getAIRecommendation, validateAIRecommendation, ALLOWED_ACTIONS };
