// Shared helpers for talking to the Shopify Admin GraphQL API with cost-based
// throttle handling. Extracted from app.client-info-cleanup.jsx so the Kibo
// reconciliation sweep can reuse the exact same backoff/pacing behaviour.

// Process work for at most this long per request, then hand a cursor back to
// the browser so it can resume. Keeps each request well under the dev-tunnel
// (~100s) and most hosting request timeouts.
export const BUDGET_MS = 25_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to wait after a THROTTLED response: drain the cost deficit at the
// shop's restore rate, falling back to exponential backoff.
export function throttleBackoff(body, attempt) {
  const cost = body?.extensions?.cost;
  const status = cost?.throttleStatus;
  if (status) {
    const deficit = (cost.requestedQueryCost ?? 100) - status.currentlyAvailable;
    const rate = status.restoreRate || 100;
    if (deficit > 0) return Math.min((deficit / rate) * 1000 + 250, 8000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

// Proactive pacing: if the cost bucket is running low after a call, pause so we
// don't walk straight into a THROTTLED error on the next one.
export function costPause(body) {
  const status = body?.extensions?.cost?.throttleStatus;
  if (!status) return 0;
  if (status.currentlyAvailable < 200) {
    const rate = status.restoreRate || 100;
    return Math.min(((200 - status.currentlyAvailable) / rate) * 1000, 3000);
  }
  return 0;
}

// Run a GraphQL operation, retrying on cost-based throttling.
export async function adminGraphql(admin, query, variables, attempt = 0) {
  const MAX = 6;
  try {
    const res = await admin.graphql(query, { variables });
    const body = await res.json();
    if (body.errors?.length) {
      const throttled = body.errors.some(
        (e) => e.extensions?.code === "THROTTLED",
      );
      if (throttled && attempt < MAX) {
        await sleep(throttleBackoff(body, attempt));
        return adminGraphql(admin, query, variables, attempt + 1);
      }
      throw new Error(body.errors.map((e) => e.message).join("; "));
    }
    return body;
  } catch (err) {
    // shopify-app-remix throws GraphqlQueryError for some failures; its .body
    // carries the same errors array.
    const throttled =
      err?.body?.errors?.some?.(
        (e) => e.extensions?.code === "THROTTLED",
      ) || /throttl/i.test(err?.message || "");
    if (throttled && attempt < MAX) {
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      return adminGraphql(admin, query, variables, attempt + 1);
    }
    throw err;
  }
}
