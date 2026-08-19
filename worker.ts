import { runDueConfigs } from "./lib/runner";
import { getSettings } from "./lib/db";
import { closeBrowser } from "./lib/vietjet";

// Everything a user would change lives in the database and is editable on the
// web, so the poller keeps no knobs of its own: it wakes every minute, checks
// whether the Start button is on, and asks which configs are due.
const HEARTBEAT_MS = 60_000;

let busy = false;

async function tick() {
  // A slow scrape must never overlap the next tick, or two browsers fight over
  // the same configs and Discord gets duplicate alerts.
  if (busy) return;
  busy = true;
  const startedAt = Date.now();
  try {
    const settings = await getSettings();
    if (!settings.running) return;

    const results = await runDueConfigs();
    if (!results.length) return;
    console.log(
      `[poller] chạy ${results.length} config trong ${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
    );
  } catch (err) {
    console.error("[poller] lượt quét lỗi:", err);
  } finally {
    // Tear the browser down between cycles so the next one starts from a clean
    // browser with no accumulated fingerprint for Vietjet to price against.
    await closeBrowser();
    busy = false;
  }
}

// Next clears the module cache on hot reload, so guard against starting the
// timer twice in the same process.
const g = globalThis as { __vjPollerStarted?: boolean };
if (!g.__vjPollerStarted) {
  g.__vjPollerStarted = true;
  console.log("[poller] sẵn sàng — bấm Start trên web để bắt đầu quét");
  setInterval(() => void tick(), HEARTBEAT_MS);
  void tick();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await closeBrowser();
      process.exit(0);
    });
  }
}
