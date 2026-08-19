import { NextResponse } from "next/server";
import { deadlineFrom } from "@/lib/limits";
import { runAllEnabled } from "@/lib/runner";
import { closeBrowser } from "@/lib/vietjet";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Nút "Quét ngay 1 lượt" trên web, cũng dùng được cho scheduler bên ngoài. */
export async function POST() {
  const startedAt = Date.now();
  try {
    return NextResponse.json(await runAllEnabled(deadlineFrom(startedAt, maxDuration)));
  } finally {
    if (process.env.VERCEL) await closeBrowser();
  }
}
