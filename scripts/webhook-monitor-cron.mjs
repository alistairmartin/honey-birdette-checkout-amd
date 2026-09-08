// Render cron entrypoint: POSTs to /api/webhook-monitor/maintenance, which
// rolls raw webhook rows up into hourly buckets and prunes old rows. Runs as a
// separate Render service, so it talks to the web service over HTTP (it can't
// share the web service's persistent disk). Presents a shared secret over HTTP.
//
// Required env: APP_URL, WEBHOOK_MONITOR_SECRET.

const appUrl = process.env.APP_URL;
const secret = process.env.WEBHOOK_MONITOR_SECRET;

if (!appUrl || !secret) {
  console.error("Missing env: APP_URL and WEBHOOK_MONITOR_SECRET are required.");
  process.exit(1);
}

const res = await fetch(
  `${appUrl.replace(/\/$/, "")}/api/webhook-monitor/maintenance`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-monitor-secret": secret,
    },
    body: "{}",
  },
);

const text = await res.text();
console.log(`[webhook-monitor] ${res.status} ${text}`);
if (!res.ok) process.exit(1);
