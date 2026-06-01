import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import { sweepAll } from "../lib/kiboChecker.server";
import { listConfiguredShops } from "../lib/kibo.server";

// Cron-driven reconciliation sweep across ALL configured regions (AU/US/UK/EU).
// Runs with no admin session, so it is guarded by a shared secret and loads each
// shop's offline session from storage.
//
// Render cron calls this hourly:
//   curl -X POST "$APP_URL/api/kibo-sweep" -H "x-kibo-sweep-secret: $KIBO_SWEEP_SECRET"
//
// Pass {"shop":"..."} in the body to sweep a single region instead of all.
export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const secret = process.env.KIBO_SWEEP_SECRET;
  if (!secret || request.headers.get("x-kibo-sweep-secret") !== secret) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional single-shop override; otherwise sweep every configured region.
  let onlyShop = null;
  try {
    const body = await request.json();
    if (body?.shop) onlyShop = body.shop;
  } catch {
    // no JSON body
  }

  const shops = onlyShop ? [onlyShop] : listConfiguredShops();
  if (!shops.length) {
    return json(
      { ok: true, swept: [], note: "No configured regions in KIBO_REGIONS." },
    );
  }

  const results = [];
  for (const shop of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const totals = await sweepAll({ admin, shop });
      results.push({ shop, ok: true, ...totals });
    } catch (err) {
      results.push({ shop, ok: false, error: err?.message || String(err) });
    }
  }

  return json({ ok: results.every((r) => r.ok), swept: results });
}

// GET is a lightweight “is this wired up” check (no work, no secret leak).
export async function loader() {
  return json({ ok: true, hint: "POST with x-kibo-sweep-secret to run a sweep." });
}
