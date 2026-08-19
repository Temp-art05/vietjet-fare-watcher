import { z } from "zod";

const iata = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Mã sân bay phải gồm 3 chữ cái, ví dụ SGN");

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải theo dạng YYYY-MM-DD");

export const configSchema = z
  .object({
    name: z.string().trim().min(1, "Cần đặt tên cho config"),
    enabled: z.boolean().default(true),
    tripType: z.enum(["oneway", "roundtrip"]),
    origin: iata,
    dest: iata,
    departFrom: isoDate,
    departTo: isoDate,
    returnFrom: isoDate.nullish(),
    returnTo: isoDate.nullish(),
    minPrice: z.number().int().min(0).default(0),
    maxPrice: z.number().int().positive("Giá trần phải lớn hơn 0"),
    mention: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || v === "everyone" || v === "here" || /^\d{17,20}$/.test(v), {
        message: "Tag phải là everyone, here, hoặc ID vai trò (17–20 chữ số)",
      }),
    pollMinutes: z
      .number()
      .int()
      .min(5, "Quét dày hơn 5 phút/lần dễ bị Vietjet chặn")
      .max(1440, "Tối đa 1 ngày/lần")
      .default(20),
    alwaysNotify: z.boolean().default(false),
    discordWebhookUrl: z
      .string()
      .url("Webhook phải là URL hợp lệ")
      .refine((u) => u.includes("discord.com/api/webhooks") || u.includes("discordapp.com/api/webhooks"), {
        message: "Phải là Discord webhook URL",
      }),
  })
  .refine((v) => v.origin !== v.dest, {
    message: "Điểm đi và điểm đến phải khác nhau",
    path: ["dest"],
  })
  .refine((v) => v.departFrom <= v.departTo, {
    message: "Ngày đi bắt đầu phải trước hoặc bằng ngày kết thúc",
    path: ["departTo"],
  })
  .refine((v) => v.minPrice <= v.maxPrice, {
    message: "Giá sàn phải nhỏ hơn hoặc bằng giá trần",
    path: ["maxPrice"],
  })
  .refine((v) => v.tripType !== "roundtrip" || (v.returnFrom && v.returnTo), {
    message: "Khứ hồi thì phải có khoảng ngày về",
    path: ["returnFrom"],
  })
  .refine((v) => v.tripType !== "roundtrip" || !v.returnFrom || !v.returnTo || v.returnFrom <= v.returnTo, {
    message: "Ngày về bắt đầu phải trước hoặc bằng ngày kết thúc",
    path: ["returnTo"],
  })
  .refine((v) => v.tripType !== "roundtrip" || !v.returnFrom || v.departFrom <= v.returnFrom, {
    message: "Ngày về không được trước ngày đi",
    path: ["returnFrom"],
  });

export type ConfigInput = z.infer<typeof configSchema>;
