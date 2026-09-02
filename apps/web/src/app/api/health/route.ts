import { NextResponse } from "next/server";
export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "creatoros",
    mode: process.env["CREATOROS_INTEGRATION_MODE"] ?? "mock",
  });
}
