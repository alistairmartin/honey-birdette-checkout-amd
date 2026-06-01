// Render cron entrypoint: POSTs to the app's /api/kibo-sweep endpoint, which
// sweeps ALL configured regions (AU/US/UK/EU). Runs as a separate Render
// service, so it talks to the web service over HTTP (it can't share the web
// service's persistent disk).
//
// Required env: APP_URL, KIBO_SWEEP_SECRET.

const appUrl = process.env.APP_URL;
const secret = process.env.KIBO_SWEEP_SECRET;

if (!appUrl || !secret) {
  console.error("Missing env: APP_URL and KIBO_SWEEP_SECRET are required.");
  process.exit(1);
}

const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/kibo-sweep`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-kibo-sweep-secret": secret,
  },
  body: "{}", // empty object -> sweep all configured regions
});

const text = await res.text();
console.log(`[kibo-sweep] ${res.status} ${text}`);
if (!res.ok) process.exit(1);
