import { json } from "@remix-run/node";
import { recordQueueSample } from "../lib/webhookMonitor.server";

// Optional queue-depth feed from the legacy webhook processor. It closes the
// gap between "what Shopify sent" (which this app sees) and "what the legacy
// backend has drained" (which it doesn't). A cron on that server posts every
// minute:
//
//   curl -s -X POST "$APP_URL/api/webhook-monitor/queue-depth" \
//     -H "x-webhook-monitor-secret: $SECRET" -H "content-type: application/json" \
//     -d "{\"shop\":\"honey-birdette-2.myshopify.com\",\"files\":$(find /path/to/queue -type f | wc -l)}"
//
// Body: { shop, files, oldestAge? } where oldestAge is seconds.
export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const secret = process.env.WEBHOOK_MONITOR_SECRET;
  if (!secret || request.headers.get("x-webhook-monitor-secret") !== secret) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400 });
  }

  const shop = String(body?.shop || "").trim().toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return json({ error: "shop must be a myshopify domain" }, { status: 400 });
  }
  if (body?.files === undefined || Number.isNaN(Number(body.files))) {
    return json({ error: "files must be a number" }, { status: 400 });
  }

  const row = await recordQueueSample({
    shop,
    files: body.files,
    oldestAge: body.oldestAge ?? null,
  });
  return json({ ok: true, id: row.id, sampledAt: row.sampledAt });
}

export async function loader() {
  return json({
    ok: true,
    hint: "POST {shop, files, oldestAge} with x-webhook-monitor-secret.",
  });
}
