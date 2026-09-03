import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import {
  CreatorError,
  creatorAssignmentSchema,
  creatorComplianceSchema,
  creatorPrioritySchema,
  updateCreatorAssignment,
  updateCreatorCompliance,
  updateCreatorPriority,
} from "@/lib/creators";

export async function PATCH(request: Request, context: { params: Promise<{ creatorId: string }> }) {
  try {
    const session = await requirePermission("creator.update");
    const creatorId = z
      .string()
      .uuid()
      .parse((await context.params).creatorId);
    const raw: unknown = await request.json();
    const keys = raw !== null && typeof raw === "object" ? raw : {};

    /**
     * One route, three writes, dispatched on which field the body carries --
     * the same shape `api/tasks/[taskId]` already uses to separate a priority
     * change from a status change. All three require `creator.update` and all
     * three take the same `updatedAt` concurrency token, so the dispatch is
     * about which columns are being written, not about authority.
     */
    if ("jurisdictionReviewStatus" in keys || "adultConfirmationStatus" in keys) {
      const body = creatorComplianceSchema.safeParse(raw);
      if (!body.success) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
      return NextResponse.json(await updateCreatorCompliance(session, creatorId, body.data));
    }

    if ("creatorSuccessUserId" in keys || "growthUserId" in keys) {
      const body = creatorAssignmentSchema.safeParse(raw);
      if (!body.success) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
      return NextResponse.json(await updateCreatorAssignment(session, creatorId, body.data));
    }

    const body = creatorPrioritySchema.safeParse(raw);
    if (!body.success) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    return NextResponse.json(await updateCreatorPriority(session, creatorId, body.data));
  } catch (error) {
    if (error instanceof AuthorizationError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof CreatorError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "INVALID_CREATOR_ID" }, { status: 400 });
    return NextResponse.json({ error: "CREATOR_UPDATE_FAILED" }, { status: 500 });
  }
}
