import { chromium, type Browser, type Page } from "playwright";

export type Fare = {
  date: string; // YYYY-MM-DD
  price: number; // VND
  flightNo: string | null;
  depTime: string | null;
  arrTime: string | null;
};

export type SearchParams = {
  origin: string; // IATA, e.g. SGN
  dest: string; // IATA, e.g. HAN
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
};

const HOME = "https://www.vietjetair.com/vi";

// Vietjet personalises fares from what it knows about a visitor, so every search
// must look like a first-time guest: a throwaway incognito context (no cookies or
// localStorage carried over) behind a rotating user agent and window size.
const PROFILES = [
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 1100 },
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1536, height: 960 },
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    viewport: { width: 1680, height: 1050 },
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  },
];

/**
 * Vietjet's booking API encrypts its request bodies and is gated by reCAPTCHA v3
 * plus AWS WAF, so there is no usable HTTP endpoint. Everything here drives the
 * real site instead. The markup uses MUI `jss*` class names that change on every
 * deploy, so selectors stick to ids, element text and `data-index`.
 */

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseISO(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const end = parseISO(to);
  for (const d = parseISO(from); d <= end; d.setDate(d.getDate() + 1)) out.push(iso(d));
  return out;
}

/** "1.790" + "000 VND" -> 1790000 */
function pricesIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/([\d.]+)\s*[\n\s]*000\s*VND/g)) {
    const n = Number(m[1].replace(/\./g, ""));
    if (Number.isFinite(n) && n > 0) out.push(n * 1000);
  }
  return out;
}

async function dismissOverlays(page: Page) {
  await page.getByText("Để sau", { exact: true }).first().click({ timeout: 4000 }).catch(() => {});
  await page.getByRole("button", { name: "Từ chối tất cả" }).first().click({ timeout: 4000 }).catch(() => {});
}

/** Walks the react-date-range calendar to the wanted month, then clicks the day. */
async function pickDate(page: Page, date: string) {
  const [y, m, d] = date.split("-");
  const want = `tháng ${m} ${y}`.toLowerCase();

  for (let i = 0; i < 30; i++) {
    const found = await page.evaluate(
      ({ want, day }) => {
        const months = [...document.querySelectorAll(".rdrMonth")].filter(
          (e) => (e as HTMLElement).offsetParent !== null,
        );
        for (const mo of months) {
          const name = mo.querySelector(".rdrMonthName")?.textContent?.trim().toLowerCase();
          if (name !== want) continue;
          for (const btn of mo.querySelectorAll("button.rdrDay")) {
            if (btn.className.includes("rdrDayPassive")) continue;
            const n = btn.querySelector(".rdrDayNumber span")?.textContent?.trim();
            if (n !== String(Number(day))) continue;
            btn.setAttribute("data-vjpick", "1");
            return { ok: true, disabled: btn.className.includes("rdrDayDisabled") };
          }
          return { ok: false as const };
        }
        return { ok: false as const };
      },
      { want, day: d },
    );

    if (found.ok) {
      if (found.disabled) throw new Error(`Vietjet không cho chọn ngày ${date}`);
      await page.locator('button[data-vjpick="1"]').first().click();
      return;
    }
    const next = page.locator("button.rdrNextButton").first();
    if (!(await next.count())) throw new Error("Không tìm thấy nút sang tháng trong lịch");
    await next.click();
    await page.waitForTimeout(350);
  }
  throw new Error(`Không mở được tháng cho ngày ${date}`);
}

async function fillPlace(page: Page, which: "origin" | "dest", iata: string) {
  // The departure input has no id; the arrival one is #arrivalPlaceDesktop.
  // Both appear twice (hero widget + sticky bottom bar) so always scope to .first().
  const input =
    which === "dest"
      ? page.locator("#arrivalPlaceDesktop").first()
      : page.locator("input.MuiOutlinedInput-input").first();

  await input.click();
  await page.waitForTimeout(400);
  await input.fill(iata);
  await page.waitForTimeout(2000);

  // The suggestion row shows the IATA code in its own element; click that row.
  const option = page
    .locator("div")
    .filter({ hasText: new RegExp(`\\b${iata}\\b`) })
    .last();
  const airportRow = page.getByText(new RegExp(`^\\s*${iata}\\s*$`)).first();
  if (await airportRow.count()) {
    await airportRow.click({ timeout: 8000 });
  } else {
    await option.click({ timeout: 8000 });
  }
  await page.waitForTimeout(1200);
}

/** Reads every date chip in the slick carousel that currently has a price. */
async function readStrip(page: Page, today: string): Promise<Map<string, number>> {
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll(".slick-slide[data-index]")].map((el) => ({
      index: Number(el.getAttribute("data-index")),
      text: (el as HTMLElement).innerText || "",
    })),
  );

  const base = parseISO(today);
  const out = new Map<string, number>();
  for (const chip of chips) {
    if (!Number.isFinite(chip.index)) continue;
    const d = new Date(base);
    d.setDate(d.getDate() + chip.index);

    // data-index counts days from today; verify against the chip's own "15 tháng 10".
    const label = chip.text.match(/(\d{1,2})\s*tháng\s*(\d{1,2})/);
    if (!label) continue;
    if (Number(label[1]) !== d.getDate() || Number(label[2]) !== d.getMonth() + 1) continue;

    const prices = pricesIn(chip.text);
    if (prices.length) out.set(iso(d), Math.min(...prices));
  }
  return out;
}

/** Clicks a date chip so the site loads that day's flights (and nearby prices). */
async function selectStripDate(page: Page, today: string, date: string) {
  const offset = Math.round((parseISO(date).getTime() - parseISO(today).getTime()) / 86_400_000);
  const chip = page.locator(`.slick-slide[data-index="${offset}"]`).first();
  if (!(await chip.count())) return false;
  await chip.click({ timeout: 10000, force: true }).catch(() => {});
  await page.waitForTimeout(6000);
  return true;
}

/** Parses the flight table currently rendered for the selected date. */
async function readFlights(page: Page, date: string): Promise<Fare[]> {
  const rows = await page.evaluate(() => {
    const seen = new Set<Element>();
    const out: string[] = [];
    for (const el of document.querySelectorAll("span")) {
      if (!/^V[JZ]\d{3,4}$/.test(el.textContent?.trim() || "")) continue;
      let node: Element | null = el;
      for (let i = 0; i < 8 && node; i++) {
        const t = (node as HTMLElement).innerText || "";
        if (t.includes("Đến") && t.includes("VND")) break;
        node = node.parentElement;
      }
      if (!node || seen.has(node)) continue;
      seen.add(node);
      out.push((node as HTMLElement).innerText || "");
    }
    return out;
  });

  const fares: Fare[] = [];
  for (const text of rows) {
    const flightNo = text.match(/\bV[JZ]\d{3,4}\b/)?.[0] ?? null;
    const times = text.match(/(\d{1,2}:\d{2})\s*Đến\s*(\d{1,2}:\d{2})/);
    const prices = pricesIn(text);
    if (!prices.length) continue; // every cabin sold out
    fares.push({
      date,
      price: Math.min(...prices),
      flightNo,
      depTime: times?.[1] ?? null,
      arrTime: times?.[2] ?? null,
    });
  }
  return fares;
}

let shared: Browser | null = null;

async function getBrowser() {
  if (shared?.isConnected()) return shared;
  shared = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  return shared;
}

export async function closeBrowser() {
  await shared?.close().catch(() => {});
  shared = null;
}

/**
 * Searches one leg and returns the cheapest fare found for every date in the
 * range that has flights. Only dates whose strip price passes `priceCeiling`
 * get a detail fetch, which keeps a wide range cheap to scan.
 */
export async function searchLeg(params: SearchParams, priceCeiling = Infinity): Promise<Fare[]> {
  const { origin, dest, from, to } = params;
  const browser = await getBrowser();
  const profile = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  // A fresh context is an incognito window: empty cookie jar and storage, thrown
  // away in the `finally` below so nothing follows us into the next search.
  const ctx = await browser.newContext({
    userAgent: profile.ua,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    viewport: profile.viewport,
    storageState: undefined,
  });
  await ctx.clearCookies();
  const page = await ctx.newPage();

  try {
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(7000);
    await dismissOverlays(page);
    await page.waitForTimeout(1000);

    await page.locator('input[value="oneway"]').first().click({ force: true });
    await page.waitForTimeout(500);

    await fillPlace(page, "origin", origin);
    await fillPlace(page, "dest", dest);

    if (!(await page.locator(".rdrCalendarWrapper").first().isVisible().catch(() => false))) {
      await page.getByText("Ngày đi", { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }
    await pickDate(page, from);
    await page.waitForTimeout(1200);

    // The hero widget gets covered by the passenger panel that opens after the
    // date pick; the sticky bottom bar carries the same controls unobstructed.
    await page.getByRole("button", { name: "Tìm chuyến bay" }).last().click({ timeout: 20_000 });
    await page.waitForURL(/select-flight/, { timeout: 60_000 });
    await page.waitForTimeout(15_000);

    const today = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });

    const wanted = eachDate(from, to);
    const lowest = new Map<string, number>();
    const fares: Fare[] = [];
    const detailed = new Set<string>();

    // Each load prices ~5 days around the selected one, so step through the
    // range in chunks instead of one page load per date.
    for (let i = 0; i < wanted.length; i += 5) {
      if (i > 0 && !(await selectStripDate(page, today, wanted[i]))) break;
      for (const [d, p] of await readStrip(page, today)) {
        if (!lowest.has(d) || p < lowest.get(d)!) lowest.set(d, p);
      }
    }

    for (const date of wanted) {
      const strip = lowest.get(date);
      if (strip === undefined || strip > priceCeiling) continue;
      if (detailed.has(date)) continue;
      detailed.add(date);

      if (!(await selectStripDate(page, today, date))) continue;
      const rows = await readFlights(page, date);
      if (rows.length) fares.push(...rows);
      else fares.push({ date, price: strip, flightNo: null, depTime: null, arrTime: null });
    }

    return fares;
  } finally {
    await ctx.close().catch(() => {});
  }
}

export function bookingUrl(origin: string, dest: string, date: string) {
  const [y, m, d] = date.split("-");
  return `https://www.vietjetair.com/vi/select-flight?from=${origin}&to=${dest}&date=${d}/${m}/${y}`;
}
