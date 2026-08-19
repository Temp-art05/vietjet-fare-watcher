import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendDiscord } from "@/lib/discord";

export const runtime = "nodejs";

/**
 * Fires a sample alert straight at the config's webhook. Real runs skip fares
 * they have already announced, which makes them useless for checking that a
 * webhook URL or a role tag actually works — this bypasses that.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = await prisma.watchConfig.findUnique({ where: { id } });
  if (!config) return NextResponse.json({ error: "Không tìm thấy config" }, { status: 404 });

  const ok = await sendDiscord(config.discordWebhookUrl, {
    configName: `${config.name} (gửi thử)`,
    origin: config.origin,
    dest: config.dest,
    tripType: config.tripType,
    departDate: config.departFrom,
    returnDate: config.tripType === "roundtrip" ? config.returnFrom : null,
    price: config.maxPrice,
    flightNo: "VJ000",
    depTime: "00:00",
    arrTime: "00:00",
    deeplink: "https://www.vietjetair.com/vi",
    mention: config.mention,
  });

  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Discord không nhận. Kiểm tra lại webhook URL." }, { status: 502 });
}
