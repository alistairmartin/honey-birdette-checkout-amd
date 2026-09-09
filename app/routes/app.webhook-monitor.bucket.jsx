import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { readBucketEvents } from "../lib/webhookMonitor.server";
import { resolveInventoryRefs } from "../lib/webhookMonitorResolve.server";

// Resource route behind the timeline bar click on /app/webhook-monitor.
// GET ?shop=&at=<bucket start ISO>&minutes=<bucket size>
//   &topic=&class=&type=&source=&repeats=1&q=   (all optional filters)
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || session.shop;
  const data = await readBucketEvents({
    shop,
    at: url.searchParams.get("at"),
    bucketMinutes: url.searchParams.get("minutes"),
    topic: url.searchParams.get("topic") || "",
    classification: url.searchParams.get("class") || "",
    resourceType: url.searchParams.get("type") || "",
    source: url.searchParams.get("source") || "",
    repeatsOnly: url.searchParams.get("repeats") === "1",
    search: url.searchParams.get("q") || "",
  });
  // Product / variant / location names for inventory rows, so the modal can
  // link them. Best effort: empty when the lookup fails.
  const refs = await resolveInventoryRefs(shop, data.events);
  return json({ ...data, refs });
}
