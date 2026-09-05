import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies that an intake submission really came from the Apps Script attached
 * to Foundry's own Google Form.
 *
 * Deliberately a parallel of `slack-signature.ts` rather than a generalisation
 * of it. Slack's scheme is Slack's; folding two external contracts into one
 * helper means a change demanded by one silently alters how the other verifies.
 * The shape is copied because it is the shape that is already correct here:
 * a timestamped HMAC over the exact bytes received, an absolute replay window,
 * and a constant-time compare that never throws on a length mismatch.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH. It proves the POST was produced by
 * something holding the shared secret — the Apps Script, whose Script Property
 * only the form's owner can read. It says nothing about who filled the form in;
 * the reference code inside the payload is a visible, editable field and can
 * never authenticate a person. That separation is the whole security model:
 * this signature gates the TRANSPORT, and an operator's own authenticated
 * decision gates what any submission is allowed to change.
 */
export const INTAKE_SIGNATURE_VERSION = "v1";

/**
 * Five minutes, matching the Slack ingress. Apps Script has no documented
 * retry, so a delivery is either prompt or lost; a wide window would buy
 * nothing and lengthen the replay opportunity.
 */
export const INTAKE_REPLAY_WINDOW_SECONDS = 300;

export const INTAKE_SIGNATURE_HEADER = "x-foundry-signature";
export const INTAKE_TIMESTAMP_HEADER = "x-foundry-timestamp";

export type IntakeVerificationFailure =
  | "MISSING_SIGNATURE"
  | "MISSING_TIMESTAMP"
  | "MALFORMED_TIMESTAMP"
  | "TIMESTAMP_OUT_OF_RANGE"
  | "UNSUPPORTED_VERSION"
  | "SIGNATURE_MISMATCH";

export type IntakeVerificationResult =
  | { valid: true }
  | { valid: false; reason: IntakeVerificationFailure };

export function signIntakeRequest(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
}): string {
  const digest = createHmac("sha256", input.signingSecret)
    .update(`${INTAKE_SIGNATURE_VERSION}:${input.timestamp}:${input.rawBody}`)
    .digest("hex");
  return `${INTAKE_SIGNATURE_VERSION}=${digest}`;
}

export function verifyIntakeRequest(input: {
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  nowSeconds?: number;
}): IntakeVerificationResult {
  if (!input.signature) return { valid: false, reason: "MISSING_SIGNATURE" };
  if (!input.timestamp) return { valid: false, reason: "MISSING_TIMESTAMP" };
  if (!/^\d+$/.test(input.timestamp)) return { valid: false, reason: "MALFORMED_TIMESTAMP" };
  if (!input.signature.startsWith(`${INTAKE_SIGNATURE_VERSION}=`))
    return { valid: false, reason: "UNSUPPORTED_VERSION" };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Absolute difference, so a timestamp from the future is rejected too.
  if (Math.abs(now - Number(input.timestamp)) > INTAKE_REPLAY_WINDOW_SECONDS)
    return { valid: false, reason: "TIMESTAMP_OUT_OF_RANGE" };

  const expected = Buffer.from(
    signIntakeRequest({
      signingSecret: input.signingSecret,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
    }),
    "utf8",
  );
  const received = Buffer.from(input.signature, "utf8");
  // timingSafeEqual throws on unequal lengths, and the exception would itself
  // leak length, so compare lengths first and constant-time compare after.
  if (expected.length !== received.length) return { valid: false, reason: "SIGNATURE_MISMATCH" };
  if (!timingSafeEqual(expected, received)) return { valid: false, reason: "SIGNATURE_MISMATCH" };
  return { valid: true };
}
