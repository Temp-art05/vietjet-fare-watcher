/**
 * Vietjet chọn tiền tệ theo IP ở phía server: bản deploy ngoài Việt Nam thấy giá
 * bằng USD, trong khi ngưỡng của config là VND. Không có proxy Việt Nam thì cách
 * còn lại là quy đổi — và quy đổi thì phải nói rõ mình đã dùng tỷ giá nào.
 */

/** Tỷ giá lấy được dùng lại trong 6h: một lượt quét không cần hỏi lại, mà cũng
 * không nên giữ tới mức lệch thị trường. */
const TTL_MS = 6 * 60 * 60 * 1000;

type Cached = { rate: number; source: string; at: number };
const cache = new Map<string, Cached>();

export type Rate = { rate: number; source: string };

/** Đủ để loại rác (HTML lỗi, số 0, NaN) mà không đoán hộ thị trường. */
const plausible = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 && n < 10_000_000;

/**
 * Bao nhiêu VND cho 1 đơn vị `currency`. Thứ tự ưu tiên: env do người dùng ấn
 * định → API miễn phí → ném lỗi kèm hướng dẫn. Không có đường "đoán một con số"
 * vì tỷ giá sai thì mọi ngưỡng giá đều sai theo, mà chẳng ai biết.
 */
export async function rateToVnd(currency: string): Promise<Rate> {
  const code = currency.toUpperCase();
  if (code === "VND") return { rate: 1, source: "không cần quy đổi" };

  const forced = code === "USD" ? Number(process.env.VJ_USD_VND) : NaN;
  if (plausible(forced)) return { rate: forced, source: "VJ_USD_VND" };

  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return { rate: hit.rate, source: hit.source };

  const rate = await fetchRate(code);
  const source = `open.er-api.com`;
  cache.set(code, { rate, source, at: Date.now() });
  return { rate, source };
}

async function fetchRate(code: string): Promise<number> {
  // Nguồn miễn phí, không cần API key. Timeout ngắn: lượt quét đã sát hạn giờ của
  // serverless, không đợi được lâu.
  const res = await fetch(`https://open.er-api.com/v6/latest/${code}`, {
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  }).catch((err: unknown) => {
    throw new Error(`Không lấy được tỷ giá ${code}→VND: ${err instanceof Error ? err.message : err}`);
  });

  if (!res.ok) throw new Error(`Không lấy được tỷ giá ${code}→VND: HTTP ${res.status}`);

  const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
  const rate = body.rates?.VND;
  if (body.result !== "success" || !plausible(rate)) {
    throw new Error(
      `Tỷ giá ${code}→VND trả về không dùng được. Đặt VJ_USD_VND (số VND cho 1 USD) để tự ấn định.`,
    );
  }
  return rate;
}
