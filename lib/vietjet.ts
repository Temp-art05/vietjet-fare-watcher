import { mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import { freemem, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type LaunchOptions, type Page } from "playwright-core";

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

/**
 * "1.790.000 VND", "1,790,000 VND", "VND 1.790.000", "1.790.000 ₫" -> 1790000.
 * Dấu phân cách và vị trí đơn vị đổi theo locale mà trang tự chọn, nên đừng khoá
 * vào đúng một dạng: đọc chệch một dạng là cả lượt quét thành "không thấy vé nào"
 * mà không có lỗi nào để lần.
 */
function pricesIn(text: string): number[] {
  const out: number[] = [];
  const add = (raw: string) => {
    const n = Number(raw.replace(/[.,\s]/g, ""));
    // Vé nội địa rẻ nhất cũng vài trăm nghìn; ngưỡng này loại số lẻ trong text.
    if (Number.isFinite(n) && n >= 10_000) out.push(n);
  };
  for (const m of text.matchAll(/(\d[\d.,\s]{3,})(?:VND|₫)/gi)) add(m[1]);
  for (const m of text.matchAll(/(?:VND|₫)\s*(\d[\d.,]{3,})/gi)) add(m[1]);
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
    const shown = [...document.querySelectorAll("input.MuiOutlinedInput-input")].filter(
      (el) => (el as HTMLElement).offsetParent !== null,
    );
    const arrival = shown.findIndex((el) => el.id === "arrivalPlaceDesktop");
    if (arrival < 1) return false;
    shown[arrival - 1].setAttribute("data-vj", "origin");
    shown[arrival].setAttribute("data-vj", "dest");
    return true;
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

    // Trang hay có panel mở ra đè lên ô nhập; lúc đó click thường không tới được
    // element, phải bắn thẳng vào toạ độ của nó.
    await input.click({ timeout: 8000 }).catch(() => input.click({ force: true, timeout: 8000 }));
    await page.waitForTimeout(400);

    // `fill()` set giá trị một nhịp, còn ô này chỉ gọi API gợi ý khi thấy từng ký
    // tự — phải gõ thật.
    await input.fill("");
    await input.pressSequentially(iata, { delay: 120 });

    // Trang chủ hydrate xong mới nhận input; gõ sớm thì React render lại là mất
    // sạch. Ký tự chưa vào ô thì chờ gợi ý cũng vô nghĩa — thử lại luôn.
    if (!(await input.inputValue().catch(() => "")).toUpperCase().includes(iata.toUpperCase())) {
      await page.waitForTimeout(1500);
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
  throw new Error(`Không chọn được ${field} ${iata} — ô đang là "${value}"`);
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
  // Đổi ngày là một lượt gọi API; chờ mạng lắng rồi chờ thêm một nhịp cho React
  // render, thay vì đặt cứng 6s cho mọi trường hợp.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
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

const isServerless = () => Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * Vietjet chọn tiền tệ theo IP ở phía server (trang không có nút đổi tiền tệ —
 * dropdown ở header chỉ có ngôn ngữ). Chạy từ nước ngoài là giá ra USD, mà ngưỡng
 * của config là VND nên không so được. `VJ_PROXY` là đường để một bản deploy ngoài
 * Việt Nam vẫn đi ra bằng IP Việt Nam.
 *
 *   VJ_PROXY=http://user:pass@host:port
 */
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
    const page = await ctx.newPage();
    return { page, close: () => ctx.close().catch(() => {}), net: watchNetwork(page) };
  }

  // Serverless: `--single-process` chặn `newContext()`, nên dùng default context
  // của một profile mới toanh trong `/tmp`. Profile rỗng thay cho cửa sổ ẩn danh,
  // và xoá thư mục lúc đóng thì không có gì theo sang lượt sau.
  await sweepTmp();
  const dir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  const ctx = await chromium.launchPersistentContext(dir, { ...(await launchOptions()), ...asGuest });
  // Chỉ chặn video: nó nặng nhất mà không ảnh hưởng layout. Ảnh và font thì phải
  // để — chặn hai thứ đó, trang co lại khác hẳn local và accordion trong trang
  // đè lên đúng ô nhập điểm đến, click không tới được.
  await ctx.route("**/*", (route) =>
    route.request().resourceType() === "media" ? route.abort() : route.continue(),
  );

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

    await page.waitForTimeout(1000);
    await oneway.click({ force: true });
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

    // Trang kết quả render dần: chờ tới lúc thật sự có giá trên dải ngày, thay vì
    // đặt cứng 15s — trang trả nhanh thì tiết kiệm được cả chục giây, mà trả chậm
    // cũng không hụt.
    await page
      .getByText(/000\s*VND/)
      .first()
      .waitFor({ state: "visible", timeout: 45_000 })
      .catch(() => {});
    await page.waitForTimeout(2000);
    mark("trang kết quả");

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
      for (const [d, p] of await readStrip(page, today)) {
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
      const rows = await readFlights(page, date);
      if (rows.length) fares.push(...rows);
      else fares.push({ date, price: strip, flightNo: null, depTime: null, arrTime: null });
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
          return {
            chips: nodes.length,
            sample: nodes
              .slice(0, 3)
              .map((el) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim()),
            url: location.href,
            body: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
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

      throw new Error(
        `Không đọc được giá nào cho ${origin}→${dest} — ${JSON.stringify(seen)}` +
          `\n[mạng] ${session.net()}\n[mốc] ${marks.join(" · ")}`,
      );
    }

    const cheapestSeen = Math.min(...lowest.values());
    mark("xong");
    console.log(
      `[vietjet] ${origin}→${dest}: ${marks.join(" · ")} · dải ngày ${lowest.size} ngày` +
        `${cheapestSeen ? `, thấp nhất ${cheapestSeen.toLocaleString("vi-VN")}` : ""}`,
    );

    return { fares, datesSeen: lowest.size, cheapestSeen };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    mark("lỗi");
    const timing = `\n[mốc] ${marks.join(" · ")}`;
    if (looksLikeCrash(err)) throw new Error(`${msg}\n[chẩn đoán] ${await crashNotes()}${timing}`);
    if (/timeout/i.test(msg)) {
      const snap = await pageSnapshot(page);
      if (snap) throw new Error(`${msg}\n[trang lúc lỗi] ${snap}${timing}`);
    }
    throw new Error(`${msg}${timing}`);
  } finally {
    await session.close();
  }
}

export function bookingUrl(origin: string, dest: string, date: string) {
  const [y, m, d] = date.split("-");
  return `https://www.vietjetair.com/vi/select-flight?from=${origin}&to=${dest}&date=${d}/${m}/${y}`;
}
