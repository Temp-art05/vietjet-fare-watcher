import type { ConfigInput } from "./schema";
import {
  mutate,
  newId,
  nowISO,
  readData,
  type Alert,
  type AppSetting,
  type WatchConfig,
} from "./store";

/* ------------------------------------------------------------------ configs */

/** Zod cho phép thiếu / undefined ở vài field; JSON thì muốn null cho gọn. */
function fromInput(input: ConfigInput) {
  return {
    name: input.name,
    enabled: input.enabled,
    tripType: input.tripType,
    origin: input.origin,
    dest: input.dest,
    departFrom: input.departFrom,
    departTo: input.departTo,
    returnFrom: input.returnFrom ?? null,
    returnTo: input.returnTo ?? null,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    discordWebhookUrl: input.discordWebhookUrl,
    mention: input.mention ?? null,
    pollMinutes: input.pollMinutes,
    alwaysNotify: input.alwaysNotify,
  };
}

const byNewest = (a: WatchConfig, b: WatchConfig) => b.createdAt.localeCompare(a.createdAt);

export async function listConfigs(): Promise<WatchConfig[]> {
  return [...(await readData()).configs].sort(byNewest);
}

export async function listEnabledConfigs(): Promise<WatchConfig[]> {
  return (await listConfigs()).filter((c) => c.enabled);
}

export async function getConfig(id: string): Promise<WatchConfig | null> {
  return (await readData()).configs.find((c) => c.id === id) ?? null;
}

export async function createConfig(input: ConfigInput): Promise<WatchConfig> {
  return mutate((data) => {
    const at = nowISO();
    const config: WatchConfig = {
      id: newId(),
      ...fromInput(input),
      lastRunAt: null,
      lastError: null,
      createdAt: at,
      updatedAt: at,
    };
    data.configs.push(config);
    return config;
  });
}

/** Ghi đè toàn bộ config từ form sửa; giữ nguyên id và lịch sử chạy. */
export async function updateConfig(id: string, input: ConfigInput): Promise<WatchConfig | null> {
  return mutate((data) => {
    const config = data.configs.find((c) => c.id === id);
    if (!config) return null;
    Object.assign(config, fromInput(input), { updatedAt: nowISO() });
    return config;
  });
}

export async function setConfigEnabled(id: string, enabled: boolean): Promise<WatchConfig | null> {
  return mutate((data) => {
    const config = data.configs.find((c) => c.id === id);
    if (!config) return null;
    config.enabled = enabled;
    config.updatedAt = nowISO();
    return config;
  });
}

export async function deleteConfig(id: string): Promise<boolean> {
  return mutate((data) => {
    const before = data.configs.length;
    data.configs = data.configs.filter((c) => c.id !== id);
    if (data.configs.length === before) return false;
    // Xoá config thì xoá luôn alert của nó, y như onDelete: Cascade trước đây.
    data.alerts = data.alerts.filter((a) => a.configId !== id);
    return true;
  });
}

/** Đóng dấu thời điểm chạy — ghi cả khi lỗi, để config hỏng vẫn chờ đủ chu kỳ. */
export async function markConfigRun(id: string, error: string | null): Promise<void> {
  await mutate((data) => {
    const config = data.configs.find((c) => c.id === id);
    if (!config) return;
    config.lastRunAt = nowISO();
    config.lastError = error;
    config.updatedAt = config.lastRunAt;
  });
}

/* ------------------------------------------------------------------- alerts */

export type AlertWithConfig = Alert & { config: { name: string } | null };

export async function listAlerts(limit = 50): Promise<AlertWithConfig[]> {
  const data = await readData();
  const names = new Map(data.configs.map((c) => [c.id, c.name]));
  return [...data.alerts]
    .sort((a, b) => b.notifiedAt.localeCompare(a.notifiedAt))
    .slice(0, limit)
    .map((a) => {
      const name = names.get(a.configId);
      return { ...a, config: name ? { name } : null };
    });
}

/** Những fingerprint đã bắn rồi, để lượt quét sau không báo lại y hệt. */
export async function knownFingerprints(fingerprints: string[]): Promise<Set<string>> {
  if (!fingerprints.length) return new Set();
  const wanted = new Set(fingerprints);
  const data = await readData();
  return new Set(data.alerts.map((a) => a.fingerprint).filter((f) => wanted.has(f)));
}

export async function createAlert(
  input: Omit<Alert, "id" | "notifiedAt">,
): Promise<Alert> {
  return mutate((data) => {
    const alert: Alert = { id: newId(), ...input, notifiedAt: nowISO() };
    data.alerts.push(alert);
    return alert;
  });
}

/* ----------------------------------------------------------------- settings */

export async function getSettings(): Promise<AppSetting> {
  return (await readData()).settings;
}

export async function updateSettings(patch: { running?: boolean }): Promise<AppSetting> {
  return mutate((data) => {
    if (patch.running !== undefined) data.settings.running = patch.running;
    data.settings.updatedAt = nowISO();
    return data.settings;
  });
}
