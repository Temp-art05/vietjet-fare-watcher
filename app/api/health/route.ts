import { NextResponse } from "next/server";
import { readData, storeStatus } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Trả lời đúng một câu hỏi: chỗ lưu dữ liệu có chạy không, và đang chạy bằng
 * driver nào. Có nó thì chẩn đoán deploy không phải đoán qua log nữa.
 * Không trả token hay BLOB_PATH — hai thứ đó là bí mật.
 */
export async function GET() {
  const status = storeStatus();
  try {
    const data = await readData();
    return NextResponse.json({
      ...status,
      ok: true,
      configs: data.configs.length,
      alerts: data.alerts.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ...status, ok: false, error: message }, { status: 500 });
  }
}
