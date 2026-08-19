/**
 * Next runs this once when the server boots, so the poller lives inside the same
 * process as the web UI — one command starts everything.
 */
export async function register() {
  // Skip the edge runtime pass; Playwright and SQLite only work on Node.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("./worker");
}
