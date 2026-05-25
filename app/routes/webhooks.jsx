import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  syncBundleAcrossDiscounts,
  syncBundleIndexToCartTransform,
} from "../lib/lubricantBundle.server";

export const action = async ({ request }) => {
  const { topic, shop, session, admin, payload } =
    await authenticate.webhook(request);

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
