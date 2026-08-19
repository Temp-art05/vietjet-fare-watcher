import { NextResponse } from "next/server";
import { runAllEnabled } from "@/lib/runner";

export const runtime = "nodejs";
export const maxDuration = 3600;

/** Lets an external scheduler drive a poll if you would rather not run worker.ts. */
export async function POST() {
  return NextResponse.json(await runAllEnabled());
}
