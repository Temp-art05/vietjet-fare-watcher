import { searchLeg, closeBrowser } from "../lib/vietjet";

const t0 = Date.now();
const fares = await searchLeg(
  { origin: "SGN", dest: "HAN", from: "2026-10-13", to: "2026-10-19" },
  2_000_000,
);
console.log(`\ngot ${fares.length} fares in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const f of fares) console.log(f.date, f.flightNo, f.depTime, "->", f.arrTime, f.price.toLocaleString("vi-VN"));
await closeBrowser();
