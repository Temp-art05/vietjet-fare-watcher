import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { deadlineFrom } from "@/lib/limits";
import { runDueConfigs } from "@/lib/runner";
import { closeBrowser } from "@/lib/vietjet";

export const runtime = "nodejs";
// 300s chạy được trên cả Hobby lẫn Pro; Pro nâng tối đa 800 được.
export const maxDuration = 300;

/**
 * Chỗ đứng của `worker.ts` khi deploy serverless: Vercel Cron gọi vào đây theo
 * lịch trong `vercel.json`, mỗi lượt hỏi đúng hai câu mà bộ poll vẫn hỏi —
 * "đang bật không" và "config nào tới hạn".
 */
export async function GET(req: Request) {
  const startedAt = Date.now();

  // Vercel Cron gắn sẵn header này; chặn để không ai ngoài lịch gọi được.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getSettings();
  if (!settings.running) return NextResponse.json({ skipped: "đang tắt" });

  try {
    return NextResponse.json(await runDueConfigs(deadlineFrom(startedAt, maxDuration)));
  } finally {
    // Serverless có thể tái dùng process cho lượt sau; để browser sống lại là
    // vừa tốn RAM vừa mang theo dấu vết Vietjet dùng để nâng giá.
    await closeBrowser();
  }
}
