import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnvironment } from "@/lib/environment";
import {
  IntakeError,
  intakePayloadSchema,
  receiveIntakeSubmission,
} from "@/lib/creator-intake";
import {
  INTAKE_SIGNATURE_HEADER,
  INTAKE_TIMESTAMP_HEADER,
  verifyIntakeRequest,
} from "@/lib/intake-signature";
import { allowRequest } from "@/lib/rate-limit";
import { captureException, getCorrelationId, logEvent } from "@/lib/observability";

/**
 * Where a creator's answers to the Model Information Sheet arrive.
 *
 * The third session-free endpoint in this app, and built to the same shape as
 * the other two (api/slack/events, api/inngest): the caller proves itself with
 * a signature over the exact bytes it sent, and everything downstream runs on
 * the service role. It is exempt from the proxy by an anchored match on this
 * exact path — see the matcher comment in src/proxy.ts.
 *
 * This endpoint STORES. It does not apply anything to a creator record. That
 * separation is the security model, because the reference code inside the body
 * is a Google Form prefill — a visible field the respondent can read, edit,
 * clear or forward — and can never authenticate a person. The signature proves
 * the POST came from Foundry's own Apps Script; an operator's authenticated,
 * audited review is what decides whether any of it touches a creator.
 */

/** Raw bytes, because re-serialising parsed JSON changes the signed input. */
async function readRawBody(request: Request): Promise<string> {
  return await request.text();
}

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const secret = getEnvironment().CREATOR_INTAKE_SIGNING_SECRET;
    // Absent secret means refuse, never "accept unsigned". An endpoint that
    // silently stops verifying because a variable failed to load is the exact
    // failure mode the proxy's own mock-mode default was fixed to avoid.
    if (!secret) {
      logEvent("error", "creator.intake.secret_missing", { correlationId });
      return NextResponse.json({ error: "INTAKE_NOT_CONFIGURED" }, { status: 503 });
    }

    const rawBody = await readRawBody(request);
    const verification = verifyIntakeRequest({
      signingSecret: secret,
      signature: request.headers.get(INTAKE_SIGNATURE_HEADER),
      timestamp: request.headers.get(INTAKE_TIMESTAMP_HEADER),
      rawBody,
    });
    if (!verification.valid) {
      logEvent("warn", "creator.intake.rejected", { correlationId, reason: verification.reason });
      return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
    }

    /**
     * Rate limited only AFTER the signature passes.
     *
     * public.api_rate_limits is keyed by `rate_key` with no cleanup job
     * anywhere, so a key derived from unauthenticated input would let anyone
     * grow that table without bound. Keying on the form id — which is a fixed
     * value that only a correctly signed request can carry — keeps the key
     * space to one row per form while still capping a runaway Apps Script.
     */
    const parsed = intakePayloadSchema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) {
      logEvent("warn", "creator.intake.malformed", {
        correlationId,
        issues: Object.keys(parsed.error.flatten().fieldErrors),
      });
      return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
    }
    if (!(await allowRequest(`intake:${parsed.data.formId}`, 60, 60_000)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });

    const receipt = await receiveIntakeSubmission(parsed.data);
    if (!receipt.stored) {
      // A signed request naming a form this deployment does not own. Reported
      // rather than stored: attributing it to an organisation would be a guess.
      logEvent("warn", "creator.intake.unknown_form", {
        correlationId,
        formId: parsed.data.formId,
      });
      return NextResponse.json({ error: "UNKNOWN_FORM" }, { status: 404 });
    }

    return NextResponse.json(
      {
        submissionId: receipt.submissionId,
        status: receipt.status,
        matched: receipt.matched,
        duplicate: receipt.duplicate,
      },
      { status: receipt.duplicate ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof IntakeError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError)
      return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
    captureException(error, { correlationId, event: "creator.intake.failed" });
    return NextResponse.json({ error: "INTAKE_FAILED" }, { status: 500 });
  }
}
