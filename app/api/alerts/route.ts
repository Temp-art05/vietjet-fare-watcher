import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { listAlerts } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  return handle(async () => NextResponse.json(await listAlerts(50)));
}
