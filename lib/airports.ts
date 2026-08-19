export type Airport = {
  code: string; // IATA
  city: string; // "Tp. Hồ Chí Minh"
  airport: string; // "Sân bay Tân Sơn Nhất"
  country: string; // "Việt Nam"
};

// Vietjet's CMS serves the airport list over plain HTTP — no captcha, no WAF —
// so this one is a normal fetch rather than a Playwright job.
const SOURCE =
  "https://vietjetcms-api.vietjetair.com/api/v1/airport?languageId=a6ca5a9f-6a9c-4f35-bf1c-c42ea3d62f14";

const TTL_MS = 24 * 60 * 60 * 1000;

let cache: { at: number; airports: Airport[] } | null = null;

type ApiResponse = {
  status?: boolean;
  airportGroups?: {
    name?: string;
    priority?: number;
    airports?: {
      code?: string;
      name?: string;
      priority?: number;
      province?: { provinceName?: string };
    }[];
  }[];
};

function normalise(data: ApiResponse): Airport[] {
  const groups = [...(data.airportGroups ?? [])].sort(
    (a, b) => (a.priority ?? 999) - (b.priority ?? 999),
  );

  const out: Airport[] = [];
  for (const group of groups) {
    const airports = [...(group.airports ?? [])].sort(
      (a, b) => (a.priority ?? 999) - (b.priority ?? 999),
    );
    for (const a of airports) {
      if (!a.code) continue;
      out.push({
        code: a.code,
        city: a.province?.provinceName || a.name || a.code,
        airport: a.name || "",
        country: group.name || "",
      });
    }
  }
  return out;
}

/**
 * Returns every airport Vietjet flies to, newest list cached for a day. On a
 * failed refresh the previous list is served rather than leaving the form empty.
 */
export async function getAirports(): Promise<Airport[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.airports;

  try {
    const res = await fetch(SOURCE, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const airports = normalise(await res.json());
    if (!airports.length) throw new Error("danh sách rỗng");

    cache = { at: Date.now(), airports };
    return airports;
  } catch (err) {
    console.error("[airports] không tải được danh sách sân bay:", err);
    if (cache) return cache.airports;
    throw err;
  }
}
