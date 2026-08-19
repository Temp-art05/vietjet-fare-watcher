import { NextResponse } from "next/server";

/**
 * Route nào ném lỗi thì Next trả 500 với body rỗng, và web chỉ hiện được
 * "Lưu thất bại (HTTP 500)" — không nói được hỏng ở đâu. Bọc qua đây để lý do
 * thật đi thẳng ra màn hình, vì phần lớn lỗi ở tầng lưu trữ là lỗi cấu hình
 * mà người dùng tự sửa được.
 */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
