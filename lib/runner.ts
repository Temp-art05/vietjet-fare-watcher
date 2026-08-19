import type { WatchConfig } from "@prisma/client";
import { prisma } from "./prisma";
import { sendDiscord, type AlertPayload } from "./discord";
import { bookingUrl, searchLeg, type Fare } from "./vietjet";

export type RunResult = {
  configId: string;
  scanned: number;
  matched: number;
  notified: number;
  error?: string;
};

/**
 * Cheapest fare per departure date, keeping every flight tied at that price —
 * two flights at the same price are two real options worth knowing about, so
 * neither gets dropped just for costing the same.
 */
function cheapestPerDate(fares: Fare[]): Map<string, Fare[]> {
  const best = new Map<string, Fare[]>();
  for (const f of fares) {
    const cur = best.get(f.date);
    if (!cur || f.price < cur[0].price) best.set(f.date, [f]);
    else if (f.price === cur[0].price) cur.push(f);
  }
  return best;
}

function cheapestOverall(fares: Fare[]): Fare | null {
  return fares.reduce<Fare | null>((a, b) => (!a || b.price < a.price ? b : a), null);
}

type Candidate = { fingerprint: string; payload: AlertPayload; fare: Fare; returnFare?: Fare };

function buildCandidates(config: WatchConfig, out: Fare[], ret: Fare[]): Candidate[] {
  const inRange = (p: number) => p >= config.minPrice && p <= config.maxPrice;

  if (config.tripType === "roundtrip") {
    // One alert for the best pairing: the watcher cares about the trip total.
    const bestOut = cheapestOverall(out);
    const bestRet = cheapestOverall(ret);
    if (!bestOut || !bestRet) return [];

    const total = bestOut.price + bestRet.price;
    if (!inRange(total)) return [];

    return [
      {
        fingerprint: `${config.id}|${bestOut.date}|${bestRet.date}|${total}`,
        fare: bestOut,
        returnFare: bestRet,
        payload: {
          configName: config.name,
          origin: config.origin,
          dest: config.dest,
          tripType: config.tripType,
          departDate: bestOut.date,
          returnDate: bestRet.date,
          price: total,
          flightNo: bestOut.flightNo,
          depTime: bestOut.depTime,
          arrTime: bestOut.arrTime,
          deeplink: bookingUrl(config.origin, config.dest, bestOut.date),
          mention: config.mention,
        },
      },
    ];
  }

  // One-way: alert the cheapest price of each qualifying date rather than every
  // flight, so a matching day does not dump ten near-identical messages into
  // Discord — but every flight sharing that cheapest price gets its own alert,
  // since two flights at the same price are two genuinely different options.
  const candidates: Candidate[] = [];
  for (const [date, fares] of cheapestPerDate(out)) {
    for (const fare of fares) {
      if (!inRange(fare.price)) continue;
      candidates.push({
        fingerprint: `${config.id}|${date}|${fare.price}|${fare.flightNo ?? "-"}`,
        fare,
        payload: {
          configName: config.name,
          origin: config.origin,
          dest: config.dest,
          tripType: config.tripType,
          departDate: date,
          price: fare.price,
          flightNo: fare.flightNo,
          depTime: fare.depTime,
          arrTime: fare.arrTime,
          deeplink: bookingUrl(config.origin, config.dest, date),
          mention: config.mention,
        },
      });
    }
  }
  return candidates;
}

export async function runConfig(config: WatchConfig): Promise<RunResult> {
  const result: RunResult = { configId: config.id, scanned: 0, matched: 0, notified: 0 };

  try {
    const outbound = await searchLeg(
      { origin: config.origin, dest: config.dest, from: config.departFrom, to: config.departTo },
      config.maxPrice,
    );

    let inbound: Fare[] = [];
    if (config.tripType === "roundtrip") {
      if (!config.returnFrom || !config.returnTo) {
        throw new Error("Config khứ hồi nhưng thiếu khoảng ngày về");
      }
      inbound = await searchLeg(
        { origin: config.dest, dest: config.origin, from: config.returnFrom, to: config.returnTo },
        config.maxPrice,
      );
    }
    result.scanned = outbound.length + inbound.length;

    const candidates = buildCandidates(config, outbound, inbound);
    result.matched = candidates.length;

    // Skip anything already announced; the price is part of the fingerprint, so a
    // changed price still notifies. `alwaysNotify` opts out of that entirely.
    const known = config.alwaysNotify
      ? new Set<string>()
      : new Set(
          (
            await prisma.alert.findMany({
              where: { fingerprint: { in: candidates.map((c) => c.fingerprint) } },
              select: { fingerprint: true },
            })
          ).map((a) => a.fingerprint),
        );

    for (const c of candidates) {
      if (known.has(c.fingerprint)) continue;

      const ok = await sendDiscord(config.discordWebhookUrl, c.payload);
      // Only record what actually reached Discord, so a failed send retries next run.
      if (!ok) continue;

      await prisma.alert.create({
        data: {
          configId: config.id,
          fingerprint: c.fingerprint,
          origin: config.origin,
          dest: config.dest,
          departDate: c.payload.departDate,
          returnDate: c.payload.returnDate ?? null,
          price: c.payload.price,
          flightNo: c.payload.flightNo ?? null,
          deeplink: c.payload.deeplink,
        },
      });
      result.notified++;
    }

    await prisma.watchConfig.update({
      where: { id: config.id },
      data: { lastRunAt: new Date(), lastError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    await prisma.watchConfig
      .update({ where: { id: config.id }, data: { lastRunAt: new Date(), lastError: message } })
      .catch(() => {});
  }

  return result;
}

async function runSequentially(configs: WatchConfig[]): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const config of configs) {
    console.log(`[runner] ${config.name} (${config.origin}→${config.dest})`);
    const r = await runConfig(config);
    console.log(
      r.error
        ? `[runner] ${config.name} lỗi: ${r.error}`
        : `[runner] ${config.name}: quét ${r.scanned}, khớp ${r.matched}, bắn ${r.notified}`,
    );
    results.push(r);
  }
  return results;
}

/** Runs every enabled config, one at a time to keep only one browser tab busy. */
export async function runAllEnabled(): Promise<RunResult[]> {
  return runSequentially(await prisma.watchConfig.findMany({ where: { enabled: true } }));
}

/**
 * Runs only the configs whose own `pollMinutes` has elapsed. `lastRunAt` is
 * written even when a run fails, so a broken config waits its full interval
 * instead of retrying on every tick.
 */
export async function runDueConfigs(): Promise<RunResult[]> {
  const configs = await prisma.watchConfig.findMany({ where: { enabled: true } });
  const now = Date.now();
  const due = configs.filter(
    (c) => !c.lastRunAt || now - c.lastRunAt.getTime() >= c.pollMinutes * 60_000,
  );
  if (!due.length) return [];
  console.log(`[runner] ${due.length}/${configs.length} config tới hạn quét`);
  return runSequentially(due);
}
