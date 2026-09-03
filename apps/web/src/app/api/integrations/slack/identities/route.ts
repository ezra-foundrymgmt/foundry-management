import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { linkSlackIdentity, unlinkSlackIdentity } from "@/lib/slack-identities";

/**
 * Slack identity administration.
 *
 * Guarded by user.manage rather than integration.manage: linking a Slack account
 * grants it the CreatorOS user's role in the Foundry agent, which is a change to
 * who can act, not to how a provider is configured.
 */
const linkSchema = z.object({
  userId: z.string().uuid(),
  // Slack member ids: U or W, then uppercase alphanumerics.
  slackUserId: z
    .string()
    .trim()
    .regex(/^[UW][A-Z0-9]{2,}$/, "SLACK_USER_ID_MALFORMED"),
});

const unlinkSchema = z.object({ userId: z.string().uuid() });

/** Reasons the caller is allowed to see, and the status each deserves. */
const CLIENT_ERRORS: Record<string, number> = {
  USER_NOT_IN_ORGANIZATION: 404,
  SLACK_USER_NOT_FOUND: 404,
  SLACK_USER_IN_DIFFERENT_WORKSPACE: 409,
  SLACK_WORKSPACE_NOT_CONNECTED: 409,
  SLACK_TOKEN_UNAVAILABLE: 409,
  SLACK_IDENTITY_NOT_FOUND: 404,
};

export async function POST(request: Request) {
  try {
    const session = await requirePermission("user.manage");
    const parsed = linkSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "INVALID_SLACK_LINK" }, { status: 400 });
    const identity = await linkSlackIdentity(session, parsed.data);
    return NextResponse.json({ status: "LINKED", identity });
  } catch (error) {
    return respond(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requirePermission("user.manage");
    const parsed = unlinkSchema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json({ error: "INVALID_SLACK_UNLINK" }, { status: 400 });
    await unlinkSlackIdentity(session, parsed.data);
    return NextResponse.json({ status: "UNLINKED" });
  } catch (error) {
    return respond(error);
  }
}

function respond(error: unknown) {
  if (error instanceof AuthorizationError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  const code = error instanceof Error ? error.message : "";
  const status = CLIENT_ERRORS[code];
  // Anything not on the list is an internal failure. Its message could carry
  // database or provider detail, so it does not reach the client.
  if (status) return NextResponse.json({ error: code }, { status });
  return NextResponse.json({ error: "SLACK_IDENTITY_REQUEST_FAILED" }, { status: 500 });
}
