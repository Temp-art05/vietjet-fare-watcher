import { searchLeg, closeBrowser } from "../lib/vietjet";

const t0 = Date.now();
// Mặc định SGN→HAN, hoặc truyền chặng/ngày khác:
//   npx tsx scripts/test-scrape.ts HAN DLI 2027-01-07 2027-01-08
const [origin = "SGN", dest = "HAN", from = "2026-10-13", to = "2026-10-19"] = process.argv.slice(2);

const { fares, datesSeen, cheapestSeen, converted } = await searchLeg({ origin, dest, from, to }, 5_000_000);
console.log(
  `\ngot ${fares.length} fares in ${((Date.now() - t0) / 1000).toFixed(0)}s` +
    ` (dải ngày ${datesSeen} ngày, thấp nhất ${cheapestSeen?.toLocaleString("vi-VN") ?? "—"}` +
    (converted ? `, quy đổi từ ${converted.currency} @ ${Math.round(converted.rate)}` : "") +
    ")",
);
for (const f of fares) console.log(f.date, f.flightNo, f.depTime, "->", f.arrTime, f.price.toLocaleString("vi-VN"));
await closeBrowser();
