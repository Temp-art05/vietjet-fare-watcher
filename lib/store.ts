import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Toàn bộ dữ liệu của tool nằm trong đúng một document JSON. Nó nhỏ (vài chục
 * config, vài nghìn alert) nên đọc/ghi nguyên file rẻ hơn nhiều so với việc kéo
 * theo một database — đổi lại mọi thay đổi phải đi qua `mutate()` để hai lượt
 * ghi không đè lên nhau.
 */

export type TripType = "oneway" | "roundtrip";

export type WatchConfig = {
  id: string;
  name: string;
  enabled: boolean;
  tripType: TripType;
  origin: string;
  dest: string;
  departFrom: string; // YYYY-MM-DD
  departTo: string;
  returnFrom: string | null;
  returnTo: string | null;
  minPrice: number;
  maxPrice: number;
  discordWebhookUrl: string;
  /** "everyone" | "here" | ID vai trò | null (không tag) */
  mention: string | null;
  pollMinutes: number;
  /** true = báo lại kể cả khi giá y hệt lần trước */
  alwaysNotify: boolean;
  lastRunAt: string | null; // ISO
  lastError: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

export type Alert = {
  id: string;
  configId: string;
  fingerprint: string;
  origin: string;
  dest: string;
  departDate: string;
  returnDate: string | null;
  price: number;
  flightNo: string | null;
  deeplink: string | null;
  notifiedAt: string; // ISO
};

export type AppSetting = {
  running: boolean; // bật/tắt bằng nút Start trên web
  updatedAt: string; // ISO
};

export type Data = {
  configs: WatchConfig[];
  alerts: Alert[];
  settings: AppSetting;
};

/**
 * Lịch sử alert chỉ dùng để khỏi báo trùng, không ai đọc lại vé của năm ngoái —
 * nên cắt bớt phần cũ để file JSON không phình vô hạn.
 */
const MAX_ALERTS = 2000;

function emptyData(): Data {
  return { configs: [], alerts: [], settings: { running: false, updatedAt: nowISO() } };
}

export function nowISO() {
  return new Date().toISOString();
}

export function newId() {
  return `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

/* ------------------------------------------------------------------ drivers */

type Driver = {
  name: string;
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
};

/** Ổ đĩa thật: chạy local hoặc trong Docker có volume. */
function fileDriver(): Driver {
  const file = path.resolve(process.env.DATA_FILE ?? "data/db.json");

  return {
    name: `file:${file}`,
    async load() {
      try {
        return await fs.readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async save(text) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Ghi ra file tạm rồi rename: mất điện giữa chừng cũng không để lại một
      // file JSON cụt đầu không parse nổi.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text, "utf8");
      await fs.rename(tmp, file);
    },
  };
}

/**
 * Vercel Blob: ổ đĩa của Vercel chỉ đọc, nên bản deploy trên đó cất file JSON
 * ra blob store. Vẫn đúng một document JSON, chỉ khác chỗ nằm.
 */
function blobDriver(): Driver {
  const pathname = process.env.BLOB_PATH ?? "vietjet-fare-watcher/db.json";
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  return {
    name: `blob:${pathname}`,
    async load() {
      const { get } = await import("@vercel/blob");
      // `useCache: false` vì blob nằm sau CDN: vừa ghi xong mà đọc bản cache thì
      // lượt sửa kế tiếp sẽ dựng trên dữ liệu cũ và xoá mất thay đổi vừa rồi.
      const res = await get(pathname, { access: "public", useCache: false, token });
      // `get` trả null đúng khi chưa có file. Mọi lỗi khác (token sai, store bị
      // xoá…) phải ném lên — nuốt nó thành "chưa có gì" là ghi đè sạch dữ liệu.
      if (!res?.stream) return null;
      return new Response(res.stream).text();
    },
    async save(text) {
      const { put } = await import("@vercel/blob");
      await put(pathname, text, {
        access: "public",
        token,
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    },
  };
}

const isServerless = () => Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * Serverless mà không có blob store thì không có chỗ nào ghi được: ổ đĩa chỉ
 * đọc. Thà báo thẳng còn hơn để `fs.mkdir` ném EROFS — lỗi đó không nói cho ai
 * biết phải làm gì.
 */
function unconfiguredDriver(): Driver {
  const fail = (): never => {
    throw new Error(
      "Chưa cấu hình chỗ lưu dữ liệu: đang chạy trên Vercel nhưng thiếu " +
        "BLOB_READ_WRITE_TOKEN, mà ổ đĩa serverless thì chỉ đọc. Vào Vercel → " +
        "Storage → Blob → tạo store rồi Redeploy lại project.",
    );
  };
  return { name: "chưa cấu hình", load: fail, save: fail };
}

const driver: Driver = process.env.BLOB_READ_WRITE_TOKEN
  ? blobDriver()
  : isServerless()
    ? unconfiguredDriver()
    : fileDriver();

export const storeName = driver.name;

/* --------------------------------------------------------------- read/write */

/** Vá dữ liệu cũ / thiếu field để một file JSON viết tay cũng chạy được. */
function normalise(raw: unknown): Data {
  const d = (raw ?? {}) as Partial<Data>;
  return {
    configs: Array.isArray(d.configs) ? d.configs : [],
    alerts: Array.isArray(d.alerts) ? d.alerts : [],
    settings: {
      running: d.settings?.running === true,
      updatedAt: d.settings?.updatedAt ?? nowISO(),
    },
  };
}

export async function readData(): Promise<Data> {
  const text = await driver.load();
  if (text === null) return emptyData();
  try {
    return normalise(JSON.parse(text));
  } catch {
    throw new Error(`File dữ liệu ${driver.name} không phải JSON hợp lệ`);
  }
}

async function writeData(data: Data): Promise<void> {
  if (data.alerts.length > MAX_ALERTS) {
    data.alerts = [...data.alerts]
      .sort((a, b) => b.notifiedAt.localeCompare(a.notifiedAt))
      .slice(0, MAX_ALERTS);
  }
  await driver.save(`${JSON.stringify(data, null, 2)}\n`);
}

// Không có transaction như database, nên các lượt ghi trong cùng process phải
// xếp hàng: đọc–sửa–ghi của lượt sau chỉ bắt đầu khi lượt trước đã ghi xong.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Đọc dữ liệu mới nhất, cho hàm `fn` sửa tại chỗ, rồi ghi lại. Trả về đúng thứ
 * `fn` trả về. `fn` ném lỗi thì không có gì được ghi.
 */
export async function mutate<T>(fn: (data: Data) => T | Promise<T>): Promise<T> {
  const run = async () => {
    const data = await readData();
    const result = await fn(data);
    await writeData(data);
    return result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}
