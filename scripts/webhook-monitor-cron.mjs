// Render cron entrypoint: POSTs to /api/webhook-monitor/maintenance, which
// rolls raw webhook rows up into hourly buckets and prunes old rows. Runs as a
// separate Render service, so it talks to the web service over HTTP (it can't
// share the web service's persistent disk). Presents a shared secret over HTTP.
//
// Retries transient failures (DNS/network errors, 502/503/504) so a brief
// Render networking blip doesn't fail the run. A missed run is also caught up
// by the next one, since rollup resumes from the last rolled-up hour.
//
// Required env: APP_URL, WEBHOOK_MONITOR_SECRET.

const appUrl = process.env.APP_URL;
const secret = process.env.WEBHOOK_MONITOR_SECRET;

if (!appUrl || !secret) {
  console.error("Missing env: APP_URL and WEBHOOK_MONITOR_SECRET are required.");
  process.exit(1);
}

const url = `${appUrl.replace(/\/$/, "")}/api/webhook-monitor/maintenance`;
const RETRY_DELAYS_MS = [10_000, 20_000, 40_000];
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 0; ; attempt++) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-monitor-secret": secret,
      },
      body: "{}",
    });
  } catch (err) {
    const reason = err?.cause?.code || err?.message || String(err);
    if (attempt < RETRY_DELAYS_MS.length) {
      console.warn(
        `[webhook-monitor] attempt ${attempt + 1} failed (${reason}), retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`,
      );
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    console.error(`[webhook-monitor] giving up after ${attempt + 1} attempts:`, err);
    process.exit(1);
  }

  const text = await res.text();
  console.log(`[webhook-monitor] ${res.status} ${text}`);
  if (res.ok) break;
  if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
    console.warn(
      `[webhook-monitor] retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`,
    );
    await sleep(RETRY_DELAYS_MS[attempt]);
    continue;
  }
  process.exit(1);
}
