/**
 * Next chạy hàm này một lần khi server khởi động, nên bộ poll sống chung process
 * với web UI — một lệnh là chạy được cả hai.
 *
 * Trên serverless (Vercel) thì không: process bị đóng ngay sau mỗi request, một
 * `setInterval` không sống nổi tới tick sau. Ở đó lịch quét do Vercel Cron gọi
 * `/api/cron` lo, xem `vercel.json`.
 */
export async function register() {
  // Bỏ qua lượt chạy cho edge runtime; Playwright chỉ chạy được trên Node.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VERCEL) return;
  await import("./worker");
}
