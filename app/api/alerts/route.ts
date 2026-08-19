import { NextResponse } from "next/server";
import { listAlerts } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await listAlerts(50));
}
