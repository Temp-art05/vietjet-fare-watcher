import { NextResponse } from "next/server";
import { getConfig } from "@/lib/db";
import { deadlineFrom } from "@/lib/limits";
import { runConfig } from "@/lib/runner";
import { closeBrowser } from "@/lib/vietjet";

export const runtime = "nodejs";
export const maxDuration = 300;

/** "Check now" from the UI — runs one config synchronously. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const config = await getConfig(id);
  if (!config) return NextResponse.json({ error: "Không tìm thấy config" }, { status: 404 });

  try {
    // Không có deadline thì hết giờ là bị chém giữa đường: không lưu được lỗi,
    // web vẫn treo nguyên dòng cũ nên trông như chẳng có gì xảy ra.
    const result = await runConfig(config, deadlineFrom(startedAt, maxDuration));
    return NextResponse.json(result, { status: result.error ? 500 : 200 });
  } finally {
    if (process.env.VERCEL) await closeBrowser();
  }
}
