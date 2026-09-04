const crypto = require("crypto");

/**
 * Verifies a Razorpay webhook signature.
 *
 * Razorpay signs every webhook body with HMAC-SHA256 using a secret
 * you configure in the Razorpay dashboard. If this check fails, the
 * request did not genuinely come from Razorpay and must be rejected
 * BEFORE any business logic runs.
 *
 * @param {string} rawBody - the raw (unparsed) request body as a string
 * @param {string} signatureHeader - value of the 'x-razorpay-signature' header
 * @param {string} webhookSecret - your Razorpay webhook secret
 * @returns {boolean}
 */
function verifyRazorpaySignature(rawBody, signatureHeader, webhookSecret) {
  if (!rawBody || !signatureHeader || !webhookSecret) return false;

  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  // timingSafeEqual requires equal-length buffers, so guard against
  // length mismatches before comparing (a shortcut here would leak
  // timing information about how many bytes matched).
  const a = Buffer.from(expectedSignature, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyRazorpaySignature };
