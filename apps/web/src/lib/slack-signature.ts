import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack signs every request as
 *   v0=HEX(HMAC_SHA256(signing_secret, "v0:" + timestamp + ":" + raw_body))
 * The body must be the exact bytes Slack sent: re-serialising parsed JSON
 * changes key order and whitespace and silently breaks verification.
 */
export const SLACK_SIGNATURE_VERSION = "v0";

/** Slack's own guidance: reject anything older than five minutes. */
export const SLACK_REPLAY_WINDOW_SECONDS = 300;

export type SlackVerificationFailure =
  | "MISSING_SIGNATURE"
  | "MISSING_TIMESTAMP"
  | "MALFORMED_TIMESTAMP"
  | "TIMESTAMP_OUT_OF_RANGE"
  | "UNSUPPORTED_VERSION"
  | "SIGNATURE_MISMATCH";

export type SlackVerificationResult =
  | { valid: true }
  | { valid: false; reason: SlackVerificationFailure };

export function signSlackRequest(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
}): string {
  const digest = createHmac("sha256", input.signingSecret)
    .update(`${SLACK_SIGNATURE_VERSION}:${input.timestamp}:${input.rawBody}`)
    .digest("hex");
  return `${SLACK_SIGNATURE_VERSION}=${digest}`;
}

export function verifySlackRequest(input: {
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  nowSeconds?: number;
}): SlackVerificationResult {
  if (!input.signature) return { valid: false, reason: "MISSING_SIGNATURE" };
  if (!input.timestamp) return { valid: false, reason: "MISSING_TIMESTAMP" };
  if (!/^\d+$/.test(input.timestamp)) return { valid: false, reason: "MALFORMED_TIMESTAMP" };
  if (!input.signature.startsWith(`${SLACK_SIGNATURE_VERSION}=`))
    return { valid: false, reason: "UNSUPPORTED_VERSION" };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Absolute difference, so a timestamp from the future is rejected too.
  if (Math.abs(now - Number(input.timestamp)) > SLACK_REPLAY_WINDOW_SECONDS)
    return { valid: false, reason: "TIMESTAMP_OUT_OF_RANGE" };

  const expected = Buffer.from(
    signSlackRequest({
      signingSecret: input.signingSecret,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
    }),
    "utf8",
  );
  const received = Buffer.from(input.signature, "utf8");
  // timingSafeEqual throws on unequal lengths, which would itself leak length
  // through an exception, so compare lengths first and always constant-time
  // compare equal-length buffers.
  if (expected.length !== received.length) return { valid: false, reason: "SIGNATURE_MISMATCH" };
  if (!timingSafeEqual(expected, received)) return { valid: false, reason: "SIGNATURE_MISMATCH" };
  return { valid: true };
}
