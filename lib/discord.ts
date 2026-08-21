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
  /** "everyone" | "here" | ID vai trò | null */
  mention?: string | null;
  /**
   * Có khi trang trả tiền tệ khác VND (IP ngoài Việt Nam): `price` là số **quy
   * đổi**, và noti phải nói ra để không ai tưởng đó là giá VND trên trang.
   */
  converted?: { amount: number; currency: string; rate: number } | null;
};

const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")} ₫`;

/** Giá quy đổi phải hiện kèm dấu ≈: sai vài phần trăm là chuyện có thật. */
const shown = (a: AlertPayload) => (a.converted ? `≈ ${vnd(a.price)}` : vnd(a.price));

const original = (c: NonNullable<AlertPayload["converted"]>) =>
  `${c.amount.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} ${c.currency}` +
  ` · 1 ${c.currency} = ${vnd(c.rate)}`;

/**
 * Discord only pings when the mention sits in `content` (embeds never ping) AND
 * `allowed_mentions` permits it. Without the allowlist a role mention renders as
 * blue text that notifies nobody, so both halves have to line up.
 */
function mentionParts(mention?: string | null) {
  if (mention === "everyone") {
    return { content: "@everyone", allowed_mentions: { parse: ["everyone"] } };
  }
  if (mention === "here") {
    return { content: "@here", allowed_mentions: { parse: ["everyone"] } };
  }
  if (mention && /^\d{17,20}$/.test(mention)) {
    // Listing the id here pings the role even when it is not "mentionable".
    return { content: `<@&${mention}>`, allowed_mentions: { parse: [], roles: [mention] } };
  }
  // Default to muting everything, so a config with no tag can never ping by accident.
  return { content: "", allowed_mentions: { parse: [] } };
}

function embed(a: AlertPayload) {
  const route =
    a.tripType === "roundtrip"
      ? `${a.origin} ⇄ ${a.dest}`
      : `${a.origin} → ${a.dest}`;

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Giá", value: shown(a), inline: true },
    { name: "Ngày đi", value: a.departDate, inline: true },
  ];
  if (a.converted) {
    fields.push({ name: "Giá gốc trên trang", value: original(a.converted), inline: false });
  }
  if (a.returnDate) fields.push({ name: "Ngày về", value: a.returnDate, inline: true });
  if (a.flightNo) {
    const time = a.depTime && a.arrTime ? ` · ${a.depTime}–${a.arrTime}` : "";
    fields.push({ name: "Chuyến", value: `${a.flightNo}${time}`, inline: true });
  }

  const ping = mentionParts(a.mention);

  return {
    username: "Vietjet Fare Watcher",
    content: ping.content,
    allowed_mentions: ping.allowed_mentions,
    embeds: [
      {
        title: `✈️ ${route} — ${shown(a)}`,
        description: `Config **${a.configName}** vừa bắt được vé trong ngưỡng giá.`,
        url: a.deeplink,
        color: 0xed1c24,
        fields,
        footer: {
          text: a.converted
            ? `Giá quy đổi từ ${a.converted.currency}, có thể lệch vài phần trăm — bấm vào tiêu đề để xem giá thật. Giá đổi bất cứ lúc nào.`
            : "Giá có thể đổi bất cứ lúc nào — đặt sớm nếu ưng.",
        },
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
