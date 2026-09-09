import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { readPayload } from "../lib/webhookMonitor.server";

// Raw body of one recorded webhook, for the "Raw" popup in the bar
// drill-down. GET ?shop=&id=<WebhookEvent.id>. Bodies are kept 3 days.
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || session.shop;
  const id = url.searchParams.get("id") || "";
  const result = id ? await readPayload({ shop, eventId: id }) : null;
  return json(result || { event: null, payload: null });
}
