import { json } from "@remix-run/node";
import { pruneOld, rollupHours } from "../lib/webhookMonitor.server";

// Hourly housekeeping for the webhook monitor, called by the Render cron
// `webhook-monitor-maintenance` (scripts/webhook-monitor-cron.mjs):
//
//   1. roll raw WebhookEvent rows up into WebhookHourly (idempotent upsert)
//   2. prune raw rows older than 30 days, raw bodies older than 3 days, hourly rollups older than 90 days,
//      queue samples older than 30 days
//
// Guarded by the same shared secret as the queue-depth feed.
export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const secret = process.env.WEBHOOK_MONITOR_SECRET;
  if (!secret || request.headers.get("x-webhook-monitor-secret") !== secret) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const rollup = await rollupHours();
  const pruned = await pruneOld();
  return json({ ok: true, rollup, pruned });
}

export async function loader() {
  return json({
    ok: true,
    hint: "POST with x-webhook-monitor-secret to roll up and prune.",
  });
}
