import { mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import { freemem, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright-core";
import { rateToVnd } from "./fx";

export type Fare = {
  date: string; // YYYY-MM-DD
  price: number; // VND
  flightNo: string | null;
  depTime: string | null;
  arrTime: string | null;
  /**
   * Chỉ có khi trang trả tiền tệ khác VND (IP ngoài Việt Nam): giá gốc và tỷ giá
   * đã dùng. Giá VND ở trên là số quy đổi, và mọi chỗ hiển thị phải nói ra điều đó.
   */
  converted?: { amount: number; currency: string; rate: number };
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

/** Số tiền đọc được từ text của trang, chưa quy đổi. */
export type Money = { amount: number; currency: string };

/** Hàm quy về VND; trả null khi không quy đổi được, để chỗ gọi bỏ qua thay vì báo sai. */
type ToVnd = (m: Money) => number | null;

const CURRENCIES = "VND|USD|EUR|AUD|SGD|KRW|JPY|TWD|THB|CNY|HKD|MYR|INR|CAD|GBP";

/**
 * "1.790.000 VND", "1,790,000 VND", "VND 1.790.000", "1.790.000 ₫", "34 USD",
 * "27 .55 USD" và "1.790 000 VND" — trang tách phần xu *và* nhóm nghìn cuối ra
 * element riêng, nên `innerText` chèn khoảng trắng vào giữa con số. Dấu phân cách
 * khác nhau theo tiền tệ nên chuẩn hoá riêng: VND không có phần thập phân,
 * USD/EUR… thì có.
 */
export function moneyIn(text: string): Money[] {
  const out: Money[] = [];

  const add = (raw: string, currency: string) => {
    const code = currency.toUpperCase();
    const cleaned = code === "VND" || code === "₫" ? raw.replace(/[.,\s]/g, "") : normaliseDecimal(raw);
    const amount = Number(cleaned);
    if (!Number.isFinite(amount)) return;
    // Vé nội địa rẻ nhất cũng vài trăm nghìn VND, hay vài USD — ngưỡng này loại
    // số lẻ lọt vào từ text xung quanh.
    if (code === "VND" ? amount < 10_000 : amount < 1) return;
    out.push({ amount, currency: code === "₫" ? "VND" : code });
  };

  // Khoảng trắng trong con số là thật, nhưng chỉ ở hai dạng: nhóm nghìn (`\s\d{3}`,
  // như "690 000 VND" — trang tách 3 số cuối ra element riêng) và phần thập phân
  // (`\s.\d{1,2}`, như "27 .55 USD"). Cho khoảng trắng tự do thì "17:35 690.000 VND"
  // bị đọc thành 35.690.000.
  //
  // Chặn đằng trước bằng lookbehind: nếu không, "17:35 690 000 VND" khớp từ "35" rồi
  // ngốn cả hai nhóm nghìn thành 35.690.000. Sau dấu `:` là giờ bay, không phải tiền.
  for (const m of text.matchAll(
    new RegExp(`(?<![:\\d])(\\d[\\d.,]*(?:\\s\\d{3})*(?:\\s?\\.\\d{1,2})?)\\s*(${CURRENCIES}|₫)`, "gi"),
  )) {
    add(m[1], m[2]);
  }
  if (out.length) return out;

  // Dạng đơn vị đứng trước chỉ dùng khi dạng trên không thấy gì: hai giá cạnh nhau
  // ("690.000 VND 1.010.000 VND") thì nó đọc lẫn sang số của giá sau.
  for (const m of text.matchAll(new RegExp(`(${CURRENCIES}|₫)\\s*(\\d[\\d.,]*)`, "gi"))) {
    add(m[2], m[1]);
  }
  return out;
}

/** "27 .55" -> "27.55", "1,234.56" -> "1234.56", "1.234" -> "1234" (dấu . là phân
 * cách nghìn khi không phải hai chữ số cuối). */
function normaliseDecimal(raw: string): string {
  const compact = raw.replace(/[\s,]/g, "");
  const parts = compact.split(".");
  if (parts.length === 1) return compact;
  const last = parts.pop()!;
  const head = parts.join("");
  return last.length === 2 ? `${head}.${last}` : head + last;
}

/** Giá thấp nhất trong một đoạn text, đã quy về VND. */
function lowestVnd(text: string, toVnd: ToVnd): { vnd: number; money: Money } | null {
  let best: { vnd: number; money: Money } | null = null;
  for (const money of moneyIn(text)) {
    const vnd = toVnd(money);
    if (vnd === null) continue;
    if (!best || vnd < best.vnd) best = { vnd, money };
  }
  return best;
}

/**
 * Bong bóng chat của Vietjet bung ra sau vài giây rồi phủ lên đúng widget tìm chuyến.
 * Playwright nói thẳng chuyện đó: `#cw_hello_message` trong `#aip-chat-box`
 * "intercepts pointer events". Container serverless chậm nên trang nằm chờ lâu hơn
 * máy local — bong bóng kịp bung, click vào ô điểm đi rơi vào nó, MUI thấy không
 * chọn gì thì xoá ô, và lỗi hiện ra chỉ là "ô đang là rỗng".
 *
 * Chat là widget bên thứ ba, không có nút đóng nào chắc chắn: ẩn thẳng bằng DOM.
 * Chỉ là DOM nên rẻ (vài ms) — gọi lại được trước mỗi lần chạm vào widget, khác với
 * `dismissOverlays` phải chờ click nên đắt.
 */
const CHAT_SELECTORS = ["#aip-chat-box", "#cw_hello_message", ".cw_hello_message", "#chat-widget-container"];

async function hideChat(page: Page) {
  await page
    .evaluate((sels) => {
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          (el as HTMLElement).style.setProperty("display", "none", "important");
        }
      }
    }, CHAT_SELECTORS)
    .catch(() => {});
}

async function dismissOverlays(page: Page) {
  await page.getByText("Để sau", { exact: true }).first().click({ timeout: 4000 }).catch(() => {});
  await page.getByRole("button", { name: "Từ chối tất cả" }).first().click({ timeout: 4000 }).catch(() => {});
  await hideChat(page);
}

/**
 * Cái gì đang nằm trên ô nhập: `elementFromPoint` ngay tâm ô. Nhìn từ dòng lỗi thì
 * popup, banner cookie hay bong bóng chat đè lên đều ra cùng một câu "ô đang là rỗng",
 * nên phải nói ra thứ đang đè — không thì lần sau lại ngồi đoán.
 */
async function whatCovers(page: Page, which: "origin" | "dest") {
  return page
    .evaluate((w) => {
      const input = document.querySelector(`input[data-vj="${w}"]`) as HTMLElement | null;
      if (!input) return "không còn ô nhập trên trang";
      const r = input.getBoundingClientRect();
      if (!r.width || !r.height) return "ô nhập không có kích thước (đang bị ẩn)";
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top) return "ô nhập nằm ngoài vùng nhìn";
      if (top === input || input.contains(top) || top.contains(input)) return "không có gì đè lên ô";
      const desc = (el: Element) => {
        const cls = typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
        return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`;
      };
      return `bị đè bởi ${desc(top)}${top.parentElement ? ` trong ${desc(top.parentElement)}` : ""}`;
    }, which)
    .catch(() => "không đọc được element đang đè");
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

/**
 * Ô điểm đi không có id, name, placeholder hay aria nào để bám (đã kiểm bằng cách
 * dump toàn bộ `<input>` của trang chủ). Thứ duy nhất chắc chắn: nó là ô đứng ngay
 * trước ô điểm đến `#arrivalPlaceDesktop` trong cùng widget — mà widget lại xuất
 * hiện hai lần (hero + thanh dính dưới). Bám theo `.first()` là bám vị trí: trang
 * render lệch một nhịp là gõ vào ô khác, và lỗi hiện ra chỉ là "ô đang là rỗng".
 * Nên gắn nhãn theo danh tính, chỉ trong nhóm ô đang thật sự hiện.
 */
async function tagPlaceInputs(page: Page) {
  return page.evaluate(() => {
    window.scrollTo(0, 0);
    const shown = [...document.querySelectorAll("input.MuiOutlinedInput-input")].filter(
      (el) => (el as HTMLElement).offsetParent !== null,
    );
    // Widget xuất hiện hai lần (hero + thanh dính dưới) và cả hai đều có thể "hiện".
    // Lấy bản hero: ô điểm đến nằm cao nhất trên trang sau khi đã cuộn lên đầu.
    let arrival = -1;
    let highest = Number.POSITIVE_INFINITY;
    shown.forEach((el, i) => {
      if (el.id !== "arrivalPlaceDesktop") return;
      const top = el.getBoundingClientRect().top;
      if (top < highest) {
        highest = top;
        arrival = i;
      }
    });
    if (arrival < 1) return false;
    for (const el of document.querySelectorAll("[data-vj]")) el.removeAttribute("data-vj");
    shown[arrival - 1].setAttribute("data-vj", "origin");
    shown[arrival].setAttribute("data-vj", "dest");
    return true;
  });
}

/**
 * Radio "một chiều" của widget hero. Cùng lý do như `tagPlaceInputs`: widget xuất
 * hiện hai lần, và `.first()` có thể trúng bản trong thanh dính dưới — bản đó không
 * đổi trạng thái nên đọc `checked` ở đấy thì lúc nào cũng thấy chưa chọn.
 */
async function tagOneWay(page: Page) {
  return page.evaluate(() => {
    window.scrollTo(0, 0);
    const radios = [...document.querySelectorAll('input[value="oneway"]')];
    if (!radios.length) return null;
    // Radio của MUI trong suốt nhưng vẫn có kích thước; lấy bản nằm cao nhất.
    const hero = radios.reduce((best, el) =>
      el.getBoundingClientRect().top < best.getBoundingClientRect().top ? el : best,
    );
    for (const el of document.querySelectorAll("[data-vj-oneway]")) el.removeAttribute("data-vj-oneway");
    hero.setAttribute("data-vj-oneway", "1");
    return (hero as HTMLInputElement).checked;
  });
}

async function fillPlace(page: Page, which: "origin" | "dest", iata: string) {
  const input = page.locator(`input[data-vj="${which}"]`).first();
  const airportRow = page.getByText(new RegExp(`^\\s*${iata}\\s*$`)).first();
  const field = which === "dest" ? "điểm đến" : "điểm đi";

  // Chọn xong thì ô nhập mang tên kèm mã, kiểu "Hà Nội (HAN)". Kiểm ngay tại đây
  // thay vì để nó hỏng tiếp ở bước sau: chọn không xong thì panel ngày không mở,
  // và lỗi hiện ra lại là "không tìm thấy nút sang tháng trong lịch".
  for (let attempt = 0; attempt < 3; attempt++) {
    // Gắn lại mỗi lượt: React render lại là attribute bay mất.
    if (!(await tagPlaceInputs(page))) {
      throw new Error(`Không thấy ô nhập ${field} trên trang — ${await pageSnapshot(page)}`);
    }

    // Bong bóng chat bung ra bất cứ lúc nào, kể cả sau khi đã ẩn một lần ở bước
    // trước. Ẩn lại ngay trước khi click: rẻ, và đây đúng là chỗ nó phá.
    await hideChat(page);

    // Trang hay có panel mở ra đè lên ô nhập; lúc đó click thường không tới được
    // element, phải bắn thẳng vào toạ độ của nó.
    await input.click({ timeout: 8000 }).catch(() => input.click({ force: true, timeout: 8000 }));
    await page.waitForTimeout(400);

    // Click có thể "thành công" mà focus vẫn ở chỗ khác (panel vừa mở chen vào);
    // lúc đó gõ bao nhiêu cũng không vào ô.
    await input.focus().catch(() => {});

    // `fill()` set thẳng giá trị nên chắc chắn vào ô, nhưng ô này chỉ gọi API gợi ý
    // khi thấy phím thật — nên set phần đầu rồi gõ ký tự cuối.
    await input.fill(iata.slice(0, -1));
    await input.pressSequentially(iata.slice(-1), { delay: 150 });

    // Chưa vào ô nghĩa là trang vẫn chưa nhận input (hydrate chậm, hoặc panel đè):
    // chờ gợi ý lúc này là vô nghĩa, thử lại luôn.
    if (!(await input.inputValue().catch(() => "")).toUpperCase().includes(iata.toUpperCase())) {
      await page.waitForTimeout(3000);
      continue;
    }

    // Hàng gợi ý hiện mã IATA trong element riêng. Chờ nó xuất hiện thay vì chờ
    // cứng vài giây: trên serverless mạng chậm hơn máy local, mà đợi cứng thì vừa
    // hay hụt vừa tốn thời gian khi trang trả nhanh.
    const appeared = await airportRow
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (appeared) {
      await airportRow
        .click({ timeout: 8000 })
        .catch(() => airportRow.click({ force: true, timeout: 8000 }));
    } else {
      // Không thấy hàng nào hiện: chọn gợi ý đầu bằng bàn phím. Click vào element
      // vô hình thì có chờ bao lâu cũng không xong.
      await input.press("ArrowDown");
      await input.press("Enter");
    }
    await page.waitForTimeout(1200);

    const value = await input.inputValue().catch(() => "");
    if (process.env.VJ_TRACE) console.log(`[vietjet] ${which}=${iata} → ô nhập "${value}"`);
    if (value.toUpperCase().includes(iata.toUpperCase())) return value;
  }

  const value = await input.inputValue().catch(() => "");
  throw new Error(`Không chọn được ${field} ${iata} — ô đang là "${value}" · ${await whatCovers(page, which)}`);
}

/** Reads every date chip in the slick carousel that currently has a price. */
async function readStrip(page: Page, today: string, toVnd: ToVnd): Promise<Map<string, number>> {
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

    const best = lowestVnd(chip.text, toVnd);
    if (best) out.set(iso(d), best.vnd);
  }
  return out;
}

/** Clicks a date chip so the site loads that day's flights (and nearby prices). */
async function selectStripDate(page: Page, today: string, date: string) {
  const offset = Math.round((parseISO(date).getTime() - parseISO(today).getTime()) / 86_400_000);
  const chip = page.locator(`.slick-slide[data-index="${offset}"]`).first();
  if (!(await chip.count())) return false;
  await chip.click({ timeout: 10000, force: true }).catch(() => {});
  // Đổi ngày là một lượt gọi API; chờ mạng lắng rồi chờ thêm một nhịp cho React
  // render, thay vì đặt cứng 6s cho mọi trường hợp.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

/** Parses the flight table currently rendered for the selected date. */
async function readFlights(
  page: Page,
  date: string,
  toVnd: ToVnd,
  rate: { currency: string; rate: number } | null,
): Promise<Fare[]> {
  const rows = await page.evaluate((currencies) => {
    const seen = new Set<Element>();
    const out: string[] = [];
    for (const el of document.querySelectorAll("span")) {
      if (!/^V[JZ]\d{3,4}$/.test(el.textContent?.trim() || "")) continue;
      let node: Element | null = el;
      const money = new RegExp(`${currencies}|₫`);
      for (let i = 0; i < 8 && node; i++) {
        const t = (node as HTMLElement).innerText || "";
        // Không khoá cứng "VND": trang trả tiền tệ theo IP, bản deploy ngoài Việt
        // Nam thấy USD nên tìm theo "có đơn vị tiền nào đó" mới đúng.
        if (t.includes("Đến") && money.test(t)) break;
        node = node.parentElement;
      }
      if (!node || seen.has(node)) continue;
      seen.add(node);
      out.push((node as HTMLElement).innerText || "");
    }
    return out;
  }, CURRENCIES);

  const fares: Fare[] = [];
  for (const text of rows) {
    const flightNo = text.match(/\bV[JZ]\d{3,4}\b/)?.[0] ?? null;
    const times = text.match(/(\d{1,2}:\d{2})\s*Đến\s*(\d{1,2}:\d{2})/);
    const best = lowestVnd(text, toVnd);
    if (!best) continue; // every cabin sold out
    fares.push({
      date,
      price: best.vnd,
      flightNo,
      depTime: times?.[1] ?? null,
      arrTime: times?.[2] ?? null,
      ...(rate && best.money.currency !== "VND"
        ? { converted: { amount: best.money.amount, currency: best.money.currency, rate: rate.rate } }
        : {}),
    });
  }
  return fares;
}

let shared: Browser | null = null;

// Cờ duy nhất mình thật sự cần: giấu dấu hiệu "trình duyệt đang bị điều khiển".
const STEALTH_ARG = "--disable-blink-features=AutomationControlled";

/**
 * Cờ duy nhất phải bỏ: `--headless='shell'` chồng lên `--headless` mà Playwright
 * tự đặt cho bản headless_shell.
 *
 * `--single-process` thì PHẢI giữ, dù nó chặn `browser.newContext()`: không có
 * nó, lần navigate đầu tiên phải spawn renderer riêng và trên Lambda việc đó
 * chết với `prctl(PR_SET_NO_NEW_PRIVS) failed` — browser sập, Playwright chỉ
 * báo lại "Target page, context or browser has been closed". Bù cho chỗ mất
 * `newContext()`, nhánh serverless đi bằng `launchPersistentContext` trong
 * `openSession()`.
 */
const INCOMPATIBLE = ["--headless"];

/** Quảng cáo, analytics, retargeting — không thứ nào cần cho việc đọc giá. */
const JUNK_HOSTS =
  /(^|\.)(doubleclick\.net|googletagmanager\.com|google-analytics\.com|googleadservices\.com|googlesyndication\.com|facebook\.net|facebook\.com|tiktok\.com|ttlivecdn\.com|twitter\.com|t\.co|criteo\.com|criteo\.net|bing\.com|clarity\.ms|snapchat\.com|sc-static\.net|adbro\.me|creativecdn\.com|tapad\.com|appier\.com|appier\.net|hotjar\.com|hotjar\.io|yandex\.ru|taboola\.com|outbrain\.com|zaloapp\.com|insider\.com)$/i;

const isServerless = () => Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * Vietjet chọn tiền tệ theo IP ở phía server (trang không có nút đổi tiền tệ —
 * dropdown ở header chỉ có ngôn ngữ). Chạy từ nước ngoài là giá ra USD, mà ngưỡng
 * của config là VND nên không so được. `VJ_PROXY` là đường để một bản deploy ngoài
 * Việt Nam vẫn đi ra bằng IP Việt Nam.
 *
 *   VJ_PROXY=http://user:pass@host:port
 */
/**
 * Mô tả proxy đang dùng, **không kèm credential** — để `/api/health` xác nhận được
 * biến môi trường đã vào bản deploy hay chưa. Đặt env rồi quên Redeploy là lỗi rất
 * dễ mắc trên Vercel, mà nhìn từ ngoài thì y như proxy không hoạt động.
 */
export function proxyStatus() {
  try {
    const proxy = proxyOption();
    if (!proxy) return { proxy: null as string | null };
    return { proxy: proxy.server, proxyAuth: Boolean(proxy.username) };
  } catch (err) {
    return { proxy: "sai định dạng", proxyError: err instanceof Error ? err.message : String(err) };
  }
}

function proxyOption() {
  const raw = process.env.VJ_PROXY;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const auth = url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {};
    return { server: `${url.protocol}//${url.host}`, ...auth };
  } catch {
    throw new Error(`VJ_PROXY không phải URL hợp lệ: ${raw}`);
  }
}

/** WebGL bật là mặc định; `VJ_GRAPHICS=0` tắt để chạy nhẹ hơn. */
const graphicsOn = () => process.env.VJ_GRAPHICS !== "0";

async function launchOptions(): Promise<LaunchOptions> {
  const proxy = proxyOption();

  if (!isServerless()) {
    // Local/Docker: dùng Chromium do `npx playwright install chromium` tải về.
    return { headless: true, args: [STEALTH_ARG, "--no-sandbox"], proxy };
  }

  // Serverless: ổ đĩa không có sẵn Chromium, phải giải nén bản đóng gói kèm.
  const { default: chromiumPack } = await import("@sparticuz/chromium");

  // Giữ nguyên graphics stack (mặc định bật): tắt đi thì nhẹ RAM hơn nhưng mất
  // WebGL, mà reCAPTCHA v3 của Vietjet soi đúng những thứ như thế. `VJ_GRAPHICS=0`
  // là cửa mở sẵn để thử nhánh nhẹ khi nghi thiếu RAM — phải đặt trước khi đọc
  // `args`, vì cờ swiftshader nằm trong chính getter đó.
  if (!graphicsOn()) chromiumPack.setGraphicsMode = false;

  const args = chromiumPack.args.filter((a) => !INCOMPATIBLE.some((bad) => a.startsWith(bad)));

  // Disk cache của chromium ghi thẳng vào `/tmp`, mà `/tmp` chỉ có 512MB và bản
  // Chromium giải nén đã ăn ~250MB trong đó. Hết chỗ ghi là chromium sập giữa
  // lúc load trang. Cờ đặt sau thắng cờ đặt trước, nên 32MB mà
  // @sparticuz/chromium khuyến nghị bị ghi đè xuống mức gần như không.
  args.push("--disk-cache-size=1", "--media-cache-size=1");

  return {
    headless: true,
    executablePath: await chromiumPack.executablePath(),
    args: [...args, STEALTH_ARG],
    proxy,
  };
}

async function getBrowser() {
  if (shared?.isConnected()) return shared;
  const browser = await chromium.launch(await launchOptions());
  // Browser chết (crash, hoặc process bị serverless chém) thì lượt sau không
  // được nhặt lại cái handle đã hỏng — `isConnected()` một mình không đủ.
  browser.on("disconnected", () => {
    if (shared === browser) shared = null;
  });
  shared = browser;
  return browser;
}

export async function closeBrowser() {
  await shared?.close().catch(() => {});
  shared = null;
}

const PROFILE_PREFIX = "vj-profile-";

/** Rác của những lượt quét trước; bản Chromium giải nén không khớp mẫu nào ở đây. */
const TMP_JUNK = [/^vj-profile-/, /^playwright/, /^chromium-crashpad/, /^\.com\.google\.Chrome/, /\.dmp$/];

async function tmpFreeBytes() {
  const info = await statfs(tmpdir()).catch(() => null);
  return info ? Number(info.bfree) * Number(info.bsize) : Number.POSITIVE_INFINITY;
}

/**
 * Invocation bị chém giữa đường để lại nguyên thư mục profile trong `/tmp`, cộng
 * minidump mỗi lần chromium sập. `/tmp` chỉ 512MB và Chromium giải nén đã chiếm
 * ~250MB, nên dồn vài lượt là hết chỗ ghi — chính là lỗi đã gặp trên production.
 *
 * Bình thường chỉ xoá thứ cũ hơn 5 phút, để không phá invocation đang chạy song
 * song trên cùng instance. Nhưng khi `/tmp` đã sát đáy thì lượt này gần như chắc
 * chắn sập, lúc đó dọn cả rác vừa sinh vẫn hơn.
 */
async function sweepTmp() {
  const root = tmpdir();
  const tight = (await tmpFreeBytes()) < 150 * 1024 * 1024;
  const cutoff = Date.now() - (tight ? 30_000 : 5 * 60_000);
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((n) => TMP_JUNK.some((junk) => junk.test(n)))
      .map(async (name) => {
        const path = join(root, name);
        const info = await stat(path).catch(() => null);
        if (!info || info.mtimeMs > cutoff) return;
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }),
  );
}

type Session = { page: Page; close: () => Promise<void>; net: () => string };

/**
 * Chặn video: nặng nhất mà không ảnh hưởng layout. Ảnh và font thì phải để — chặn
 * hai thứ đó, trang co lại khác hẳn và accordion trong trang đè lên đúng ô nhập
 * điểm đến, click không tới được.
 *
 * Chặn luôn quảng cáo và tracker: một lượt tải trang gọi ~200 request, phần lớn là
 * mấy thứ đó, và chúng ăn đúng thứ serverless đang thiếu — CPU. Trang hydrate chậm
 * thì click với gõ đều rơi vào khoảng trắng. Không chạm vietjetair.com, reCAPTCHA
 * hay AWS WAF: đó là phần trang thật sự cần.
 *
 * Đặt cho **cả local lẫn serverless**: hai bên chạy khác nhau thì local không còn
 * phản chiếu production, và bài học vụ chặn ảnh là đúng chỗ đó.
 */
async function blockNoise(ctx: BrowserContext) {
  await ctx.route("**/*", (route) => {
    if (route.request().resourceType() === "media") return route.abort();
    return JUNK_HOSTS.test(new URL(route.request().url()).hostname) ? route.abort() : route.continue();
  });
}

/**
 * Trang có thể render đủ khung mà không có giá nào, vì lời gọi API giá bị chặn
 * (WAF/reCAPTCHA soi IP datacenter) chứ không phải vì hết vé. Nhìn từ DOM thì hai
 * chuyện đó giống nhau, nên phải nghe thẳng tầng mạng.
 */
function watchNetwork(page: Page) {
  const status = new Map<string, number>();
  const flagged: string[] = [];

  page.on("response", (res) => {
    const url = res.url();
    const code = res.status();
    const type = res.request().resourceType();
    if (type === "xhr" || type === "fetch") {
      const key = `${type} ${code}`;
      status.set(key, (status.get(key) ?? 0) + 1);
    }
    const suspicious = code >= 400 || /awswaf|captcha|challenge|blocked/i.test(url);
    if (suspicious && flagged.length < 8) flagged.push(`${code} ${url.slice(0, 110)}`);
  });

  return () => {
    const counts = [...status.entries()].map(([k, n]) => `${k}×${n}`).join(", ") || "không có xhr/fetch";
    return flagged.length ? `${counts} · đáng ngờ: ${flagged.join(" | ")}` : counts;
  };
}

/**
 * Một lượt search một tab, và luôn là một "khách lần đầu": cookie/storage rỗng,
 * user agent và cỡ cửa sổ xoay theo `PROFILES`.
 */
async function openSession(profile: (typeof PROFILES)[number]): Promise<Session> {
  const asGuest = {
    userAgent: profile.ua,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    viewport: profile.viewport,
  };

  if (!isServerless()) {
    // Local/Docker: một browser dùng chung cho cả tiến trình, mỗi lượt search
    // một context mới — đúng nghĩa cửa sổ ẩn danh.
    const browser = await getBrowser();
    const ctx = await browser.newContext({ ...asGuest, storageState: undefined });
    await ctx.clearCookies();
    await blockNoise(ctx);
    const page = await ctx.newPage();
    return { page, close: () => ctx.close().catch(() => {}), net: watchNetwork(page) };
  }

  // Serverless: `--single-process` chặn `newContext()`, nên dùng default context
  // của một profile mới toanh trong `/tmp`. Profile rỗng thay cho cửa sổ ẩn danh,
  // và xoá thư mục lúc đóng thì không có gì theo sang lượt sau.
  await sweepTmp();
  const dir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  const ctx = await chromium.launchPersistentContext(dir, { ...(await launchOptions()), ...asGuest });
  await blockNoise(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return {
    page,
    net: watchNetwork(page),
    close: async () => {
      await ctx.close().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

/** Dung lượng thật của một entry trong `/tmp`, kể cả khi nó là thư mục. */
async function entrySize(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  const names = await readdir(path).catch(() => [] as string[]);
  const sizes = await Promise.all(names.map((name) => entrySize(join(path, name))));
  return sizes.reduce((a, b) => a + b, 0);
}

function looksLikeCrash(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return /has been closed|Target closed|Target crashed|browser has disconnected/i.test(msg);
}

/**
 * Chromium sập thì Playwright chỉ nói "browser has been closed", không nói vì
 * sao. Đính trạng thái máy vào message để dòng lỗi hiện trên web tự tố nguyên
 * nhân — hết RAM, hay hết chỗ trong `/tmp`.
 */
async function crashNotes() {
  const notes = [
    `RAM đã dùng ${mb(totalmem() - freemem())}/${mb(totalmem())}MB`,
    `RSS ${mb(process.memoryUsage().rss)}MB`,
  ];
  notes.push(`/tmp còn ${mb(await tmpFreeBytes())}MB`);
  notes.push(`graphics ${graphicsOn() ? "on" : "off"}`);

  // Ai đang ăn hết `/tmp` — không có dòng này thì chỉ biết là hết chỗ, không biết
  // vì cái gì.
  const root = tmpdir();
  const names = await readdir(root).catch(() => [] as string[]);
  const sized = await Promise.all(
    names.map(async (name) => ({ name, size: await entrySize(join(root, name)) })),
  );
  const biggest = sized
    .sort((a, b) => b.size - a.size)
    .slice(0, 4)
    .map((e) => `${e.name} ${mb(e.size)}MB`);
  if (biggest.length) notes.push(`/tmp: ${biggest.join(" · ")}`);

  return notes.join(", ");
}

/**
 * Ngoài vé đã lọc theo ngưỡng, một lượt quét còn biết "dải ngày có gì": bao nhiêu
 * ngày có giá và giá thấp nhất trong đó. Không có hai số này thì `quét 0 vé` vừa
 * có thể là không đọc được gì, vừa có thể là không ngày nào dưới ngưỡng.
 */
export type LegResult = {
  fares: Fare[];
  datesSeen: number;
  cheapestSeen: number | null;
  /** Có khi giá trên trang không phải VND: mọi số VND trong kết quả là số quy đổi. */
  converted?: { currency: string; rate: number };
};

/**
 * Trang chủ Vietjet không phải lúc nào cũng là trang mình quen: có thể là màn
 * chặn của WAF, hay một biến thể layout khác vì IP của serverless nằm ở region
 * khác. Timeout mà không kể lại trang thực sự nhận được thì chỉ biết "không thấy
 * element", không biết vì sao.
 */
async function pageSnapshot(page: Page) {
  const snap = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang,
      oneway: Boolean(document.querySelector('input[value="oneway"]')),
      arrival: Boolean(document.querySelector("#arrivalPlaceDesktop")),
      calendar: Boolean(document.querySelector(".rdrCalendarWrapper")),
      text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    }))
    .catch(() => null);
  if (!snap) return null;

  const has = [
    `oneway ${snap.oneway ? "có" : "không"}`,
    `ô đến ${snap.arrival ? "có" : "không"}`,
    `lịch ${snap.calendar ? "có" : "không"}`,
  ].join("/");
  return `url ${snap.url} · title "${snap.title}" · lang "${snap.lang}" · ${has} · text "${snap.text}"`;
}

/**
 * Searches one leg and returns the cheapest fare found for every date in the
 * range that has flights. Only dates whose strip price passes `priceCeiling`
 * get a detail fetch, which keeps a wide range cheap to scan.
 */
export async function searchLeg(
  params: SearchParams,
  priceCeiling = Infinity,
  deadline?: number,
): Promise<LegResult> {
  const { origin, dest, from, to } = params;
  const profile = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  // Session bị bỏ đi ở `finally` bên dưới nên không có gì theo sang lượt sau.
  const session = await openSession(profile);
  const page = session.page;

  // Serverless chém function khi hết giờ, và bị chém thì không còn gì kể lại.
  // Mốc thời gian từng bước đi kèm mọi lỗi/dừng sớm, để biết bước nào ăn hết giờ.
  const t0 = Date.now();
  const marks: string[] = [];
  const mark = (name: string) => {
    const at = `${name} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    marks.push(at);
    // Lượt quét kéo dài vài phút; `VJ_TRACE=1` cho thấy nó đang ở bước nào thay vì
    // phải chờ tới lúc kết thúc mới biết.
    if (process.env.VJ_TRACE) console.log(`[vietjet] ${origin}→${dest} · ${at}`);
  };
  const outOfTime = () => deadline !== undefined && Date.now() >= deadline;

  try {
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 90_000 });

    // Widget tìm chuyến render bằng JS sau khi trang tải, nên chờ đúng nó thay vì
    // chờ cứng — trang trả nhanh thì đi tiếp luôn, trả chậm thì không hụt. Không
    // thấy widget thì reload một lần trước khi bỏ cuộc: có lần Vietjet trả về
    // trang không có nó.
    const oneway = page.locator('input[value="oneway"]').first();
    for (let attempt = 0; ; attempt++) {
      await page.waitForTimeout(3000);
      await dismissOverlays(page);
      const found = await oneway
        .waitFor({ state: "attached", timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
      if (found) break;
      if (attempt >= 1) {
        throw new Error(`Trang chủ Vietjet không có widget tìm chuyến — ${await pageSnapshot(page)}`);
      }
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
    }

    mark("trang chủ");

    await tagOneWay(page);

    // Element xuất hiện KHÁC với trang đã hydrate xong. Bấm radio "một chiều" tới
    // khi nó báo đã chọn: đó là bằng chứng React đã gắn handler, và chờ ở đây thì
    // mấy bước sau không gõ vào một ô chưa sống.
    //
    // Nhưng đây chỉ là *tín hiệu*, không phải điều kiện: trang có thể đã nhận tương
    // tác mà `checked` vẫn không phản ánh (mình đọc nhầm bản radio, hay MUI giữ state
    // ở chỗ khác). Hết lượt chờ thì đi tiếp — chỗ kiểm thật là `fillPlace`, nó tự
    // xác nhận giá trị đã vào ô.
    // Container serverless CPU yếu hơn máy local nhiều, mà trang này hydrate nặng:
    // đo được trang chủ 18.5s ở Vercel so với 10.7s ở local. Nên chờ tới ~45s thay
    // vì 10s — vẫn nằm trong deadline, mà bỏ cuộc sớm thì cả lượt quét thành rác.
    let interactive = false;
    for (let attempt = 0; attempt < 20 && !interactive; attempt++) {
      if (attempt > 0) await page.waitForTimeout(2000);
      await page.locator('input[data-vj-oneway="1"]').first().click({ force: true, timeout: 5000 }).catch(() => {});
      interactive = (await tagOneWay(page)) === true;
      if (outOfTime()) break;
    }
    mark(interactive ? "hydrate" : "hydrate?");
    await page.waitForTimeout(500);

    await fillPlace(page, "origin", origin);
    await fillPlace(page, "dest", dest);
    mark("điểm đi/đến");

    // Panel lịch thường tự mở sau khi chọn điểm đến; không mở thì bấm "Ngày đi".
    // Trên serverless nhịp chậm hơn nên phải thử lại, và nếu vẫn không mở thì báo
    // đúng chuyện đó — chứ để `pickDate` chạy trên trang không có lịch thì lỗi
    // hiện ra là "không tìm thấy nút sang tháng", trỏ sai chỗ.
    const calendar = page.locator(".rdrCalendarWrapper").first();
    for (let attempt = 0; !(await calendar.isVisible().catch(() => false)); attempt++) {
      if (attempt >= 3) throw new Error(`Không mở được lịch chọn ngày — ${await pageSnapshot(page)}`);
      await page
        .getByText("Ngày đi", { exact: true })
        .first()
        .click({ timeout: 8000 })
        .catch(() => {});
      await calendar.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    }
    mark("mở lịch");

    await pickDate(page, from);
    await page.waitForTimeout(1200);
    mark("chọn ngày");

    // The hero widget gets covered by the passenger panel that opens after the
    // date pick; the sticky bottom bar carries the same controls unobstructed.
    await page.getByRole("button", { name: "Tìm chuyến bay" }).last().click({ timeout: 20_000 });
    await page.waitForURL(/select-flight/, { timeout: 60_000 });
    if (process.env.VJ_TRACE) console.log(`[vietjet] url trang kết quả: ${page.url()}`);

    // Trang kết quả render dần: chờ tới lúc thật sự có giá trên dải ngày, thay vì
    // đặt cứng 15s — trang trả nhanh thì tiết kiệm được cả chục giây, mà trả chậm
    // cũng không hụt.
    // Trang kết quả render dần. Chờ tới lúc **parser đọc được giá** trên dải ngày,
    // chứ đừng chờ một mẫu text nào đó: nhãn "VND" ở header khớp ngay trong 2s và
    // dẫn tới đọc dải ngày khi giá còn chưa về.
    // Đọc **toàn bộ** chip, không phải mấy chip đầu: giá chỉ render quanh ngày đang
    // chọn, nên với ngày xa (dải ngày dài cả trăm chip) thì phần đầu luôn rỗng.
    const stripMoney = async () =>
      moneyIn(
        await page.evaluate(() =>
          [...document.querySelectorAll(".slick-slide[data-index]")]
            .map((el) => (el as HTMLElement).innerText || "")
            .join(" "),
        ),
      );

    let pageMoney = await stripMoney();
    for (let waited = 0; !pageMoney.length && waited < 45; waited++) {
      await page.waitForTimeout(1000);
      pageMoney = await stripMoney();
    }
    mark("trang kết quả");

    // Tiền tệ do trang chọn theo IP, nên phải hỏi trang chứ đừng giả định. Lấy tỷ
    // giá đúng một lần cho cả lượt: tỷ giá đổi giữa lượt thì hai ngày cạnh nhau
    // lại tính bằng hai mức khác nhau, không so được với nhau nữa.
    const foreign = pageMoney.find((m) => m.currency !== "VND");
    const fx = foreign ? await rateToVnd(foreign.currency) : null;
    if (fx && foreign) {
      console.log(
        `[vietjet] trang trả giá bằng ${foreign.currency}, quy đổi 1 ${foreign.currency} =` +
          ` ${Math.round(fx.rate).toLocaleString("vi-VN")} ₫ (${fx.source})`,
      );
    }
    const rate = foreign && fx ? { currency: foreign.currency, rate: fx.rate } : null;

    // Quy về VND để so với ngưỡng của config. Tiền tệ nào không có tỷ giá thì trả
    // null — bỏ qua còn hơn báo một con số sai.
    const toVnd: ToVnd = (m) => {
      if (m.currency === "VND") return m.amount;
      if (rate && m.currency === rate.currency) return Math.round(m.amount * rate.rate);
      return null;
    };

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
      if (outOfTime()) break;
      if (i > 0 && !(await selectStripDate(page, today, wanted[i]))) break;
      for (const [d, p] of await readStrip(page, today, toVnd)) {
        if (!lowest.has(d) || p < lowest.get(d)!) lowest.set(d, p);
      }
    }
    mark("dải giá");

    for (const date of wanted) {
      if (outOfTime()) break;
      const strip = lowest.get(date);
      if (strip === undefined || strip > priceCeiling) continue;
      if (detailed.has(date)) continue;
      detailed.add(date);

      if (!(await selectStripDate(page, today, date))) continue;
      const rows = await readFlights(page, date, toVnd, rate);
      if (rows.length) fares.push(...rows);
      else {
        // Không đọc được bảng chuyến: giá trên dải ngày vẫn là thông tin thật, chỉ
        // là không biết chuyến nào. Giá gốc thì tính lại từ số đã quy đổi.
        const converted = rate ? { amount: strip / rate.rate, currency: rate.currency, rate: rate.rate } : undefined;
        fares.push({ date, price: strip, flightNo: null, depTime: null, arrTime: null, ...(converted ? { converted } : {}) });
      }
    }

    // Không đọc được giá nào là hỏng, không phải "hết vé": báo lỗi kèm đúng nội
    // dung trang đang hiện, vì đây là chỗ duy nhất biết được trang trả về cái gì.
    if (!lowest.size && outOfTime()) {
      throw new Error(`Hết giờ khi quét ${origin}→${dest} — ${marks.join(" · ")}`);
    }
    if (!lowest.size) {
      const seen = await page
        .evaluate(() => {
          const nodes = [...document.querySelectorAll(".slick-slide[data-index]")];
          const texts = nodes.map((el) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim());
          const nonEmpty = texts.filter(Boolean);
          // Chip nào cũng có chữ số (số ngày), nên chữ số không nói được gì. Tín hiệu
          // thật là **ký hiệu tiền tệ**: có nó mà parser vẫn không ra số ⇒ định dạng giá
          // đã đổi; không có nó ⇒ giá thật sự chưa về. Hai chuyện đó sửa khác nhau.
          const withMoney = nonEmpty.filter((t) => /(VND|₫|USD|EUR|AUD|SGD|KRW|JPY|TWD|THB|CNY|HKD|MYR|INR|CAD|GBP)/i.test(t));
          return {
            chips: nodes.length,
            chipsWithText: nonEmpty.length,
            chipsWithMoney: withMoney.length,
            // 3 chip đầu luôn là hôm nay và mai — chưa bao giờ nói được gì. Lấy
            // nhiều hơn, và tách riêng chip có ký hiệu tiền — đó là chỗ giá phải nằm.
            sample: nonEmpty.slice(0, 10),
            moneySample: withMoney.slice(0, 6),
            selected: nodes
              .filter((el) => /active|selected/i.test(el.className))
              .map((el) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim()),
            url: location.href,
            body: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 600),
          };
        })
        .catch(() => null);
      // Giá có thể đang hiện bằng tiền tệ khác: Vietjet chọn theo IP, và ngưỡng
      // của config là VND nên không so được. Nói thẳng ra, đừng để nó trông giống
      // "trang đổi giao diện".
      const other = seen?.sample.join(" ").match(/\b(USD|EUR|AUD|SGD|KRW|JPY|TWD|THB|CNY|HKD|MYR|INR|CAD|GBP)\b/);
      if (other) {
        const region = process.env.VERCEL_REGION ? ` (region ${process.env.VERCEL_REGION})` : "";
        throw new Error(
          `Trang đang trả giá bằng ${other[1]}, không phải VND — Vietjet chọn tiền tệ theo IP và bản deploy này` +
            `${region} nằm ngoài Việt Nam. Ngưỡng giá của config là VND nên không so được. Chạy từ IP Việt Nam` +
            ` (bản Docker/VPS) hoặc đặt VJ_PROXY=http://user:pass@host:port trỏ vào proxy Việt Nam.` +
            `\n[dải ngày] ${seen?.sample.join(" | ")}\n[mốc] ${marks.join(" · ")}`,
        );
      }

      // Dải ngày có chip nhưng không chip nào có giá là dấu hiệu Vietjet đang giữ
      // giá với IP này — hay gặp khi quét quá dày. Nói ra để khỏi đi sửa selector
      // trong khi chẳng có gì hỏng.
      const withheld = (seen?.chips ?? 0) > 0;
      // Có chip kèm số mà không quy ra được giá nào ⇒ đừng đổ cho Vietjet giữ giá,
      // đây là parser đọc trượt định dạng mới. Nói đúng cái đang xảy ra.
      const looksLikeParser = (seen?.chipsWithMoney ?? 0) > 0;
      throw new Error(
        `Không đọc được giá nào cho ${origin}→${dest}` +
          (looksLikeParser
            ? ` — dải ngày có ${seen?.chips} ngày, ${seen?.chipsWithMoney} ngày có ký hiệu tiền` +
              ` tệ trên chip mà không đọc ra được số tiền nào. Định dạng giá của trang đã đổi:` +
              ` xem [chip có giá] rồi đối chiếu \`moneyIn()\`.`
            : withheld
              ? ` — dải ngày có ${seen?.chips} ngày (${seen?.chipsWithText} ngày có chữ) nhưng không` +
                ` ngày nào kèm giá. Thường là Vietjet tạm giữ giá với IP này vì quét quá dày;` +
                ` giãn chu kỳ quét rồi thử lại sau ít lâu.`
              : ` — không có chip ngày nào trên trang.`) +
          `\n[dải ngày] ${seen?.sample.join(" | ")}` +
          `\n[chip có giá] ${seen?.moneySample.length ? seen.moneySample.join(" | ") : "không có"}` +
          `\n[chip đang chọn] ${seen?.selected.length ? seen.selected.join(" | ") : "không xác định"}` +
          `\n[url] ${seen?.url}\n[trang] ${seen?.body}` +
          `\n[mạng] ${session.net()}\n[mốc] ${marks.join(" · ")}`,
      );
    }

    const cheapestSeen = Math.min(...lowest.values());
    mark("xong");
    console.log(
      `[vietjet] ${origin}→${dest}: ${marks.join(" · ")} · dải ngày ${lowest.size} ngày` +
        `${cheapestSeen ? `, thấp nhất ${cheapestSeen.toLocaleString("vi-VN")}` : ""}`,
    );

    return { fares, datesSeen: lowest.size, cheapestSeen, ...(rate ? { converted: rate } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    mark("lỗi");
    const timing = `\n[mốc] ${marks.join(" · ")}`;
    // Browser đã chết thì hỏi trang là vô nghĩa; chẩn đoán tài nguyên nói được nhiều hơn.
    if (looksLikeCrash(err)) throw new Error(`${msg}\n[chẩn đoán] ${await crashNotes()}${timing}`);

    // Đính trang lúc lỗi + tầng mạng cho **mọi** lỗi, không riêng timeout: lỗi
    // "không chọn được điểm đi" trước đây chỉ có đúng một dòng trống trơn, đọc trên
    // web không biết trang đang là gì, cũng không biết API gợi ý có bị WAF chặn hay
    // không — phải chạy lại ở local mới đoán ra, mà local thì không tái hiện.
    // Bỏ qua khi message đã tự kèm rồi, để khỏi in hai lần.
    const snap = /url https?:/.test(msg) ? null : await pageSnapshot(page);
    const net = msg.includes("[mạng]") ? "" : `\n[mạng] ${session.net()}`;
    throw new Error(`${msg}${snap ? `\n[trang lúc lỗi] ${snap}` : ""}${net}${timing}`);
  } finally {
    await session.close();
  }
}

/**
 * Vietjet **không có deeplink**. Trang kết quả là `/vi/select-flight` trần: chặng và
 * ngày nằm trong client state, không nằm trên URL (đo trực tiếp: `page.url()` sau khi
 * bấm "Tìm chuyến bay" không có một tham số nào). Mọi dạng `?from=&to=&date=` — kể cả
 * `?tripType=`, bản `/en/`, và dạng hash — đều bị 302 về trang chủ.
 *
 * Nên link trong thông báo chỉ trỏ được về trang chủ; chặng/ngày/giá đã nằm sẵn trong
 * các field của embed để người bấm điền lại. Trả URL trang kết quả giả như trước thì
 * người bấm rơi vào trang chủ trống mà không hiểu vì sao.
 */
export function bookingUrl() {
  return "https://www.vietjetair.com/vi/";
}
