export type AlertPayload = {
  configName: string;
  origin: string;
  dest: string;
  tripType: string;
  departDate: string;
  returnDate?: string | null;
  price: number;
  flightNo?: string | null;
  depTime?: string | null;
  arrTime?: string | null;
  deeplink: string;
};

const vnd = (n: number) => `${n.toLocaleString("vi-VN")} ₫`;

function embed(a: AlertPayload) {
  const route =
    a.tripType === "roundtrip"
      ? `${a.origin} ⇄ ${a.dest}`
      : `${a.origin} → ${a.dest}`;

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Giá", value: vnd(a.price), inline: true },
    { name: "Ngày đi", value: a.departDate, inline: true },
  ];
  if (a.returnDate) fields.push({ name: "Ngày về", value: a.returnDate, inline: true });
  if (a.flightNo) {
    const time = a.depTime && a.arrTime ? ` · ${a.depTime}–${a.arrTime}` : "";
    fields.push({ name: "Chuyến", value: `${a.flightNo}${time}`, inline: true });
  }

  return {
    username: "Vietjet Fare Watcher",
    embeds: [
      {
        title: `✈️ ${route} — ${vnd(a.price)}`,
        description: `Config **${a.configName}** vừa bắt được vé trong ngưỡng giá.`,
        url: a.deeplink,
        color: 0xed1c24,
        fields,
        footer: { text: "Giá có thể đổi bất cứ lúc nào — đặt sớm nếu ưng." },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** Posts one alert. Returns false on failure so the caller can retry later. */
export async function sendDiscord(webhookUrl: string, alert: AlertPayload): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(embed(alert)),
      });
      if (res.ok) return true;

      // Discord rate limit: wait out the window once, then give up for this run.
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "2");
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
        continue;
      }
      console.error(`[discord] ${res.status} ${await res.text().catch(() => "")}`);
      return false;
    } catch (err) {
      console.error("[discord] gửi thất bại:", err);
    }
  }
  return false;
}
