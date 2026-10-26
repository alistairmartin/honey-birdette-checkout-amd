import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  syncBundleAcrossDiscounts,
  syncBundleIndexToCartTransform,
} from "../lib/lubricantBundle.server";
import {
  MONITORED_TOPICS,
  readWebhookHeaders,
  recordWebhookEvent,
} from "../lib/webhookMonitor.server";
import { tagGiftRedemptions } from "../lib/loyaltyExclusives.server";

export const action = async ({ request }) => {
  // Read headers and body size before authenticate.webhook consumes the body.
  // These are observation-only inputs for the webhook monitor.
  const monitorHeaders = readWebhookHeaders(request);
  const payloadBytes = Number(request.headers.get("content-length")) || 0;

  const { topic, shop, session, admin, payload } =
    await authenticate.webhook(request);

  // Webhook monitor: record and return, never process. One cheap insert, no
  // Admin API, and it runs even when the shop has uninstalled (no admin) so
  // the record is complete. See WEBHOOK_MONITOR_HANDOFF.md.
  if (MONITORED_TOPICS.has(topic)) {
    // Not awaited: Shopify fails a delivery that takes over 5 seconds, and a
    // busy database (rollup, prune, a heavy dashboard read) must never be the
    // reason. The 200 goes out now and the insert finishes in the background.
    recordWebhookEvent({
      shop,
      topic,
      payload,
      headers: monitorHeaders,
      payloadBytes,
    }).catch((err) => {
      console.error(`[webhook-monitor] ${topic} on ${shop} failed:`, err?.message || err);
    });
    // One-per-customer gifts (GWP and loyalty exclusives): tag the customer with
    // each redeemed gift's tag. Also not awaited, for the same 5-second reason.
    if (topic === "ORDERS_CREATE" && admin) {
      tagGiftRedemptions(admin, shop, payload)
        .then(({ tagged }) => {
          if (tagged.length) console.log(`[gwp-redeemed] ${shop} order ${payload?.name}: tagged ${tagged.join(", ")}`);
        })
        .catch((err) => {
          console.error(`[gwp-redeemed] ${shop} order ${payload?.name} failed:`, err?.message || err);
        });
    }
    throw new Response();
  }

  if (!admin) {
    // The admin context isn't returned if the webhook fired after a shop was uninstalled.
    throw new Response();
  }

  switch (topic) {
    case "APP_UNINSTALLED":
      if (session) {
        await db.session.deleteMany({ where: { shop } });
      }
      break;

    case "METAOBJECTS_UPDATE": {
      const { touched } = await syncBundleAcrossDiscounts(admin, {
        payload,
        deleted: false,
      });
      const cartTransform = await syncBundleIndexToCartTransform(admin);
      console.log(
        `[lubricant_bundle] update ${payload?.id} on ${shop} → ${touched} discount(s) re-synced; cart-transform: ${JSON.stringify(cartTransform)}`,
      );
      break;
    }

    case "METAOBJECTS_DELETE": {
      const { touched } = await syncBundleAcrossDiscounts(admin, {
        payload,
        deleted: true,
      });
      const cartTransform = await syncBundleIndexToCartTransform(admin);
      console.log(
        `[lubricant_bundle] delete ${payload?.id} on ${shop} → ${touched} discount(s) cleaned; cart-transform: ${JSON.stringify(cartTransform)}`,
      );
      break;
    }

    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};
