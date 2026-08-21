import { moneyIn } from "../lib/vietjet";
import { rateToVnd } from "../lib/fx";

// Chuỗi thật lấy từ chip dải ngày của bản deploy Vercel (IP ngoài VN) và của local.
// Cột thứ hai là kết quả **phải** ra, so khớp chính xác — trước đây script chỉ in ra
// rồi luôn `exit 0`, nên định dạng giá đổi mà nó vẫn báo xanh.
const cases: [string, string][] = [
  ["Thứ năm 20 tháng 8 Từ 34 USD", "34 USD"],
  ["Thứ sáu 21 tháng 8 Từ 27 .55 USD", "27.55 USD"],
  ["1.790.000 VND", "1790000 VND"],
  ["1,790,000 VND", "1790000 VND"],
  ["VND 1.790.000", "1790000 VND"],
  ["490.000 ₫", "490000 VND"],
  ["Từ 1,234.56 USD", "1234.56 USD"],
  ["15 tháng 10 Thứ ba", "—"],
  ["VJ403 15:45 Đến 17:35 690.000 VND 1.010.000 VND", "690000 VND | 1010000 VND"],

  // Định dạng mới của trang: 3 số cuối nằm ở element riêng nên `innerText` chèn
  // khoảng trắng. Đây đúng là thứ làm cả lượt quét báo "không đọc được giá nào".
  ["Thứ bảy 5 tháng 9 Từ 690 000 VND", "690000 VND"],
  ["Thứ năm 3 tháng 9 Từ 1.790 000 VND", "1790000 VND"],
  ["Chủ nhật 6 tháng 9 Từ 1.010 000 VND", "1010000 VND"],
  ["Từ 1 790 000 VND", "1790000 VND"],
  // Giờ bay không được biến thành tiền, kể cả khi giá ngay sau nó bị tách nhóm nghìn.
  ["VJ403 15:45 Đến 17:35 690 000 VND", "690000 VND"],
];

let bad = 0;
for (const [text, expect] of cases) {
  const got = moneyIn(text).map((m) => `${m.amount} ${m.currency}`).join(" | ") || "—";
  const ok = got === expect;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${got.padEnd(26)} ← "${text}"`);
  if (!ok) console.log(`${" ".repeat(5)}mong đợi: ${expect}`);
}
console.log(bad ? `\n${bad}/${cases.length} ca sai` : `\n${cases.length}/${cases.length} ca đúng`);

// Quy đổi: đúng đường mà bản Vercel sẽ đi.
const { rate, source } = await rateToVnd("USD");
console.log(`\ntỷ giá USD→VND: ${Math.round(rate).toLocaleString("vi-VN")} (${source})`);
for (const usd of [27.55, 34, 19.2]) {
  console.log(`  ${usd} USD → ${Math.round(usd * rate).toLocaleString("vi-VN")} ₫`);
}
console.log(`ngưỡng 500.000 ₫ tương đương ${(500_000 / rate).toFixed(2)} USD`);
process.exit(bad);
