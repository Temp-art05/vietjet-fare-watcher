import { prisma } from "./prisma";

export const SETTINGS_ID = "singleton";

/** Reads the one settings row, creating it with defaults on first call. */
export async function getSettings() {
  return prisma.appSetting.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID },
  });
}

export async function updateSettings(data: { running?: boolean }) {
  return prisma.appSetting.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, ...data },
  });
}
