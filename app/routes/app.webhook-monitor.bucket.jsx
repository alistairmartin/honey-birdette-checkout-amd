import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { readBucketEvents } from "../lib/webhookMonitor.server";

// Resource route behind the timeline bar click on /app/webhook-monitor.
// GET ?shop=&at=<bucket start ISO>&minutes=<bucket size>&topic=<optional>
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const data = await readBucketEvents({
    shop: url.searchParams.get("shop") || session.shop,
    at: url.searchParams.get("at"),
    bucketMinutes: url.searchParams.get("minutes"),
    topic: url.searchParams.get("topic") || "",
  });
  return json(data);
}
