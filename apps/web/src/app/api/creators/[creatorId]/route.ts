import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { CreatorError, creatorPrioritySchema, updateCreatorPriority } from "@/lib/creators";

export async function PATCH(request: Request, context: { params: Promise<{ creatorId: string }> }) {
  try {
    const session = await requirePermission("creator.update");
    const creatorId = z
      .string()
      .uuid()
      .parse((await context.params).creatorId);
    const body = creatorPrioritySchema.safeParse(await request.json());
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
