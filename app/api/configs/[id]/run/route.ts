import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runConfig } from "@/lib/runner";

export const runtime = "nodejs";
export const maxDuration = 600;

/** "Check now" from the UI — runs one config synchronously. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = await prisma.watchConfig.findUnique({ where: { id } });
  if (!config) return NextResponse.json({ error: "Không tìm thấy config" }, { status: 404 });

  const result = await runConfig(config);
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}
