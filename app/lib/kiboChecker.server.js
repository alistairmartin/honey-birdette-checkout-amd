// Reconciliation + reimport logic for the Kibo Checker.
//
// Detection is a sweep: list recent Shopify orders, ask Kibo (search by
// externalId) which ones it actually has, and record the missing ones as
// KiboFailedOrder rows. Reimport re-checks Kibo first (so a warehouse manual
// entry is never duplicated), then imports the order via the Kibo API.

import prisma from "../db.server";
import { adminGraphql, costPause, sleep, BUDGET_MS } from "./adminGraphql.server";
import {
  findOrderByExternalId,
  createOrder,
  isConfigured,
} from "./kibo.server";

const CLIENT_INFO_KEY = "_client_info";
const CLIENT_INFO_LIMIT = 500;

// Orders younger than this are skipped: the connector pulls asynchronously, so a
// just-placed order legitimately may not be in Kibo yet (avoids false flags).
const DEFAULT_GRACE_MINUTES = 60;
const DEFAULT_SINCE_DAYS = 7;
const MAX_ERRORS = 50;

// Lightweight fields for the sweep.
const ORDERS_QUERY = `#graphql
  query KiboSweepOrders($q: String!, $cursor: String) {
    orders(first: 50, query: $q, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        legacyResourceId
        customAttributes { key value }
      }
    }
  }`;

// Fuller fields needed to build a Kibo import payload.
const ORDER_DETAIL_QUERY = `#graphql
  query KiboOrderDetail($id: ID!) {
    order(id: $id) {
      id
      name
      legacyResourceId
      createdAt
      email
      currencyCode
      customAttributes { key value }
      totalPriceSet { shopMoney { amount currencyCode } }
      shippingAddress {
        firstName lastName address1 address2 city province provinceCode
        zip country countryCodeV2 phone
      }
      billingAddress {
        firstName lastName address1 address2 city province provinceCode
        zip country countryCodeV2 phone
      }
      lineItems(first: 100) {
        nodes {
          quantity
          name
          sku
          variant { id sku }
          originalUnitPriceSet { shopMoney { amount } }
        }
      }
    }
  }`;

function getAttr(order, key) {
  return order.customAttributes?.find((a) => a.key === key)?.value ?? null;
}

// Decide a likely reason + suggested fix for an order Kibo is missing. The first
// rule is the known failure (oversized _client_info); extend this list as new
// failure causes are found.
export function diagnose(order) {
  const clientInfo = getAttr(order, CLIENT_INFO_KEY);
  if (clientInfo && clientInfo.length > CLIENT_INFO_LIMIT) {
    return {
      reason: `${CLIENT_INFO_KEY} is ${clientInfo.length} chars (Kibo limit ${CLIENT_INFO_LIMIT})`,
      suggestion: `Reimport will truncate ${CLIENT_INFO_KEY} to ${CLIENT_INFO_LIMIT} chars before sending to Kibo.`,
    };
  }
  return {
    reason: "Not found in Kibo (cause unknown)",
    suggestion:
      "Re-check Kibo, then reimport. If it fails again, inspect the order for unusual data.",
  };
}

// Run one batch of the sweep. Returns the same shape the page's fetcher resume
// loop expects, so detection can stream progress to the browser. When called
// from the cron endpoint, the caller loops until done.
export async function sweepBatch({
  admin,
  shop,
  cursor = null,
  sinceDays = DEFAULT_SINCE_DAYS,
  graceMinutes = DEFAULT_GRACE_MINUTES,
  budgetMs = BUDGET_MS,
}) {
  if (!isConfigured(shop)) {
    return {
      done: true,
      nextCursor: null,
      pageScanned: 0,
      pageFlagged: 0,
      pageRecovered: 0,
      errors: [],
      fatalError: `Kibo is not configured for ${shop}.`,
    };
  }

  const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const untilIso = new Date(Date.now() - graceMinutes * 60_000).toISOString();
  const q = `created_at:>='${sinceIso}' AND created_at:<='${untilIso}'`;

  const deadline = Date.now() + budgetMs;
  let scanned = 0;
  let flagged = 0;
  let recovered = 0;
  let done = false;
  const errors = [];

  try {
    while (true) {
      const body = await adminGraphql(admin, ORDERS_QUERY, { q, cursor });
      const orders = body.data.orders;

      for (const order of orders.nodes) {
        scanned++;
        try {
          const kiboId = await findOrderByExternalId(shop, {
            externalId: order.legacyResourceId,
            orderName: order.name,
          });

          if (kiboId) {
            // Present in Kibo. If we'd previously flagged it as pending, mark it
            // recovered (the warehouse or a retry got it in).
            const updated = await prisma.kiboFailedOrder.updateMany({
              where: { shop, shopifyOrderId: order.id, status: "PENDING" },
              data: {
                status: "EXISTS_IN_KIBO",
                kiboOrderId: String(kiboId),
                lastCheckedAt: new Date(),
              },
            });
            if (updated.count) recovered++;
            continue;
          }

          // Missing from Kibo -> record it. Upsert so re-sweeps don't duplicate;
          // don't clobber a row that's already resolved/reimported.
          const { reason, suggestion } = diagnose(order);
          const existing = await prisma.kiboFailedOrder.findUnique({
            where: { shop_shopifyOrderId: { shop, shopifyOrderId: order.id } },
          });
          if (existing) {
            await prisma.kiboFailedOrder.update({
              where: { id: existing.id },
              data: { lastCheckedAt: new Date(), reason, suggestion },
            });
          } else {
            await prisma.kiboFailedOrder.create({
              data: {
                shop,
                shopifyOrderId: order.id,
                shopifyOrderName: order.name,
                orderCreatedAt: new Date(order.createdAt),
                reason,
                suggestion,
                status: "PENDING",
              },
            });
            flagged++;
          }
        } catch (err) {
          if (errors.length < MAX_ERRORS) {
            errors.push(`${order.name}: ${err?.message || String(err)}`);
          }
        }
        await sleep(costPause(body));
      }

      cursor = orders.pageInfo.hasNextPage ? orders.pageInfo.endCursor : null;
      if (!cursor) {
        done = true;
        break;
      }
      if (Date.now() > deadline) break;
    }
  } catch (err) {
    return {
      done: true,
      nextCursor: null,
      pageScanned: scanned,
      pageFlagged: flagged,
      pageRecovered: recovered,
      errors,
      fatalError: err?.message || String(err),
    };
  }

  return {
    done,
    nextCursor: cursor,
    pageScanned: scanned,
    pageFlagged: flagged,
    pageRecovered: recovered,
    errors,
    fatalError: null,
  };
}

// Loop sweepBatch to completion. Used by the cron endpoint (no browser to drive
// the resume loop). Budget per batch still applies; we just keep going.
export async function sweepAll({ admin, shop, sinceDays, graceMinutes }) {
  let cursor = null;
  const totals = { scanned: 0, flagged: 0, recovered: 0, errors: [] };
  for (let i = 0; i < 1000; i++) {
    const r = await sweepBatch({ admin, shop, cursor, sinceDays, graceMinutes });
    totals.scanned += r.pageScanned;
    totals.flagged += r.pageFlagged;
    totals.recovered += r.pageRecovered;
    if (r.errors?.length) totals.errors.push(...r.errors);
    if (r.fatalError) {
      totals.fatalError = r.fatalError;
      break;
    }
    if (r.done) break;
    cursor = r.nextCursor;
  }
  return totals;
}

// Build the Kibo import payload from a full Shopify order.
//
// IMPORTANT: the exact required fields for this tenant must be confirmed against
// the Kibo sandbox (see plan "Open items"). This is a best-effort mapping; the
// _client_info truncation (the known fix) is applied here.
function buildKiboOrderPayload(order) {
  const clientInfoRaw = getAttr(order, CLIENT_INFO_KEY);
  const clientInfo =
    clientInfoRaw && clientInfoRaw.length > CLIENT_INFO_LIMIT
      ? clientInfoRaw.slice(0, CLIENT_INFO_LIMIT)
      : clientInfoRaw;

  const items = (order.lineItems?.nodes || []).map((li) => ({
    product: { productCode: li.variant?.sku || li.sku || undefined },
    quantity: li.quantity,
    unitPrice: {
      listPrice: Number(li.originalUnitPriceSet?.shopMoney?.amount || 0),
    },
  }));

  return {
    externalId: String(order.legacyResourceId),
    email: order.email || undefined,
    currencyCode: order.currencyCode || "AUD",
    channelCode: "Online",
    total: Number(order.totalPriceSet?.shopMoney?.amount || 0),
    items,
    // Carry the (truncated) client info through. Field name to be confirmed
    // against how the connector maps it into the Kibo order.
    ...(clientInfo
      ? { attributes: [{ fullyQualifiedName: CLIENT_INFO_KEY, values: [clientInfo] }] }
      : {}),
    fulfillmentInfo: order.shippingAddress
      ? {
          fulfillmentContact: {
            firstName: order.shippingAddress.firstName,
            lastNameOrSurname: order.shippingAddress.lastName,
            phoneNumbers: { home: order.shippingAddress.phone || undefined },
            address: {
              address1: order.shippingAddress.address1,
              address2: order.shippingAddress.address2 || undefined,
              cityOrTown: order.shippingAddress.city,
              stateOrProvince: order.shippingAddress.provinceCode,
              postalOrZipCode: order.shippingAddress.zip,
              countryCode: order.shippingAddress.countryCodeV2,
            },
          },
        }
      : undefined,
  };
}

// Reimport a single failed-order record.
//   1. Re-check Kibo by externalId (warehouse-got-there guard).
//   2. If absent, fetch the full Shopify order, build the payload (applying the
//      known fix), and import it.
export async function reimport({ admin, shop, recordId }) {
  const record = await prisma.kiboFailedOrder.findFirst({
    where: { id: recordId, shop },
  });
  if (!record) return { ok: false, status: "NOT_FOUND", message: "Record not found." };
  if (!isConfigured(shop)) {
    return { ok: false, status: record.status, message: `Kibo is not configured for ${shop}.` };
  }

  // 1. Warehouse-got-there guard.
  const existingKiboId = await findOrderByExternalId(shop, {
    externalId: record.shopifyOrderId.split("/").pop(),
    orderName: record.shopifyOrderName,
  });
  if (existingKiboId) {
    await prisma.kiboFailedOrder.update({
      where: { id: record.id },
      data: {
        status: "EXISTS_IN_KIBO",
        kiboOrderId: String(existingKiboId),
        lastCheckedAt: new Date(),
      },
    });
    return {
      ok: true,
      status: "EXISTS_IN_KIBO",
      message: `Already in Kibo (order ${existingKiboId}) - skipped to avoid a duplicate.`,
    };
  }

  // 2. Build payload from the full Shopify order and import.
  try {
    const body = await adminGraphql(admin, ORDER_DETAIL_QUERY, {
      id: record.shopifyOrderId,
    });
    const order = body.data.order;
    if (!order) throw new Error("Shopify order no longer exists.");

    const payload = buildKiboOrderPayload(order);
    const kiboOrderId = await createOrder(shop, payload);

    await prisma.kiboFailedOrder.update({
      where: { id: record.id },
      data: {
        status: "REIMPORTED",
        kiboOrderId: kiboOrderId ? String(kiboOrderId) : null,
        attempts: record.attempts + 1,
        lastError: null,
        lastCheckedAt: new Date(),
      },
    });
    return {
      ok: true,
      status: "REIMPORTED",
      message: `Imported into Kibo${kiboOrderId ? ` (order ${kiboOrderId})` : ""}.`,
    };
  } catch (err) {
    const message = err?.message || String(err);
    await prisma.kiboFailedOrder.update({
      where: { id: record.id },
      data: {
        status: "REIMPORT_FAILED",
        attempts: record.attempts + 1,
        lastError: message,
        lastCheckedAt: new Date(),
      },
    });
    return { ok: false, status: "REIMPORT_FAILED", message };
  }
}

// Re-check a single record against Kibo without importing (the "Re-check"
// button). Flips PENDING/REIMPORT_FAILED -> EXISTS_IN_KIBO if found.
export async function recheck({ shop, recordId }) {
  const record = await prisma.kiboFailedOrder.findFirst({
    where: { id: recordId, shop },
  });
  if (!record) return { ok: false, message: "Record not found." };
  if (!isConfigured(shop)) return { ok: false, message: `Kibo is not configured for ${shop}.` };

  const kiboId = await findOrderByExternalId(shop, {
    externalId: record.shopifyOrderId.split("/").pop(),
    orderName: record.shopifyOrderName,
  });
  await prisma.kiboFailedOrder.update({
    where: { id: record.id },
    data: {
      lastCheckedAt: new Date(),
      ...(kiboId
        ? { status: "EXISTS_IN_KIBO", kiboOrderId: String(kiboId) }
        : {}),
    },
  });
  return {
    ok: true,
    found: !!kiboId,
    message: kiboId
      ? `Found in Kibo (order ${kiboId}).`
      : "Still not in Kibo.",
  };
}
