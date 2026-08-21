import { NextResponse } from "next/server";
import { readData, storeStatus } from "@/lib/store";
import { proxyStatus } from "@/lib/vietjet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Trả lời đúng một câu hỏi: chỗ lưu dữ liệu có chạy không, và đang chạy bằng
 * driver nào. Có nó thì chẩn đoán deploy không phải đoán qua log nữa.
 * Kể thêm proxy đang dùng (chỉ host, không credential): đặt `VJ_PROXY` mà quên
 * Redeploy là lỗi rất dễ mắc, mà nhìn từ ngoài thì y như proxy không hoạt động.
 * Không trả token, credential hay BLOB_PATH — mấy thứ đó là bí mật.
 */
export async function GET() {
  const status = { ...storeStatus(), ...proxyStatus(), region: process.env.VERCEL_REGION ?? null };
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
