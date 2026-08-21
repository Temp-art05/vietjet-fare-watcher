import { moneyIn } from "../lib/vietjet";
import { rateToVnd } from "../lib/fx";

// Chuỗi thật lấy từ chip dải ngày của bản deploy Vercel (IP ngoài VN) và của local.
const cases: [string, string][] = [
  ["Thứ năm 20 tháng 8 Từ 34 USD", "34 USD"],
  ["Thứ sáu 21 tháng 8 Từ 27 .55 USD", "27.55 USD — trang tách phần xu ra element riêng"],
  ["1.790.000 VND", "1790000 VND"],
  ["1,790,000 VND", "1790000 VND"],
  ["VND 1.790.000", "1790000 VND"],
  ["490.000 ₫", "490000 VND"],
  ["Từ 1,234.56 USD", "1234.56 USD"],
  ["15 tháng 10 Thứ ba", "không có giá"],
  ["VJ403 15:45 Đến 17:35 690.000 VND 1.010.000 VND", "690000 + 1010000, KHÔNG được dính 17:35"],
];

let bad = 0;
for (const [text, expect] of cases) {
  const got = moneyIn(text).map((m) => `${m.amount} ${m.currency}`).join(" | ") || "—";
  console.log(`${got.padEnd(30)} ← "${text}"\n${" ".repeat(32)}mong đợi: ${expect}`);
}

// Quy đổi: đúng đường mà bản Vercel sẽ đi.
const { rate, source } = await rateToVnd("USD");
console.log(`\ntỷ giá USD→VND: ${Math.round(rate).toLocaleString("vi-VN")} (${source})`);
for (const usd of [27.55, 34, 19.2]) {
  console.log(`  ${usd} USD → ${Math.round(usd * rate).toLocaleString("vi-VN")} ₫`);
}
console.log(`ngưỡng 500.000 ₫ tương đương ${(500_000 / rate).toFixed(2)} USD`);
process.exit(bad);
