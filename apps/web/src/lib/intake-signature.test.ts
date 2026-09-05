import { describe, expect, it } from "vitest";
import {
  INTAKE_REPLAY_WINDOW_SECONDS,
  signIntakeRequest,
  verifyIntakeRequest,
} from "./intake-signature";

/**
 * This signature is the only thing standing between the open internet and a
 * write into creator_intake_submissions, so every rejection path is asserted
 * rather than assumed.
 */
const SECRET = "a-shared-secret-only-the-apps-script-holds";
const NOW = 1_788_600_000;
const BODY = JSON.stringify({ formId: "abc", responseId: "r1", answers: [] });

function signed(overrides: Partial<{ timestamp: string; rawBody: string; secret: string }> = {}) {
  const timestamp = overrides.timestamp ?? String(NOW);
  const rawBody = overrides.rawBody ?? BODY;
  return {
    signature: signIntakeRequest({
      signingSecret: overrides.secret ?? SECRET,
      timestamp,
      rawBody,
    }),
    timestamp,
    rawBody,
  };
}

function verify(input: {
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  nowSeconds?: number;
}) {
  return verifyIntakeRequest({ signingSecret: SECRET, nowSeconds: NOW, ...input });
}

describe("intake request signature", () => {
  it("accepts a correctly signed request", () => {
    expect(verify(signed())).toEqual({ valid: true });
  });

  it("rejects a body that changed after signing", () => {
    const request = signed();
    // The shape of a real attack: keep the signature, swap the reference code.
    const tampered = { ...request, rawBody: request.rawBody.replace("r1", "r2") };
    expect(verify(tampered)).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("rejects a signature made with a different secret", () => {
    expect(verify(signed({ secret: "not-the-secret" }))).toEqual({
      valid: false,
      reason: "SIGNATURE_MISMATCH",
    });
  });

  it("rejects a missing signature or timestamp rather than defaulting to trust", () => {
    const request = signed();
    expect(verify({ ...request, signature: null })).toEqual({
      valid: false,
      reason: "MISSING_SIGNATURE",
    });
    expect(verify({ ...request, timestamp: null })).toEqual({
      valid: false,
      reason: "MISSING_TIMESTAMP",
    });
  });

  it("rejects a non-numeric timestamp", () => {
    const request = signed();
    expect(verify({ ...request, timestamp: "yesterday" })).toEqual({
      valid: false,
      reason: "MALFORMED_TIMESTAMP",
    });
  });

  it("rejects an unknown signature version", () => {
    const request = signed();
    expect(verify({ ...request, signature: `v9=${request.signature.slice(3)}` })).toEqual({
      valid: false,
      reason: "UNSUPPORTED_VERSION",
    });
  });

  it("rejects a replay from outside the window, in both directions", () => {
    const request = signed();
    const stale = NOW + INTAKE_REPLAY_WINDOW_SECONDS + 1;
    const future = NOW - INTAKE_REPLAY_WINDOW_SECONDS - 1;
    expect(verify({ ...request, nowSeconds: stale })).toEqual({
      valid: false,
      reason: "TIMESTAMP_OUT_OF_RANGE",
    });
    // A timestamp from the future is rejected too: without the absolute
    // difference, a forged far-future timestamp would never expire.
    expect(verify({ ...request, nowSeconds: future })).toEqual({
      valid: false,
      reason: "TIMESTAMP_OUT_OF_RANGE",
    });
  });

  it("accepts a request at the edge of the window", () => {
    const request = signed();
    expect(verify({ ...request, nowSeconds: NOW + INTAKE_REPLAY_WINDOW_SECONDS })).toEqual({
      valid: true,
    });
  });

  it("does not throw when the signature is a different length", () => {
    // timingSafeEqual throws on unequal lengths; the length check must come
    // first or a short signature becomes a 500 instead of a 401.
    const request = signed();
    expect(() => verify({ ...request, signature: "v1=short" })).not.toThrow();
    expect(verify({ ...request, signature: "v1=short" })).toEqual({
      valid: false,
      reason: "SIGNATURE_MISMATCH",
    });
  });

  it("is not interchangeable with the Slack scheme", async () => {
    // Both are HMAC-SHA256 over "<version>:<ts>:<body>", so a shared secret
    // would make a Slack signature valid here and vice versa. The version
    // prefix is what keeps the two contracts apart.
    const { signSlackRequest } = await import("./slack-signature");
    const timestamp = String(NOW);
    const slack = signSlackRequest({ signingSecret: SECRET, timestamp, rawBody: BODY });
    expect(verify({ signature: slack, timestamp, rawBody: BODY })).toEqual({
      valid: false,
      reason: "UNSUPPORTED_VERSION",
    });
  });
});
