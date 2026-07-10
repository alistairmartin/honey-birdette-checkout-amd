import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  InlineStack,
  Badge,
  Banner,
  Box,
  Button,
  Divider,
  Link,
  Thumbnail,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  SUPPORTED_CURRENCIES,
  TRIGGER_TYPES,
  buildFunctionConfig,
  triggerUsesMinSpend,
} from "../lib/gwpAppV1.shared";

// Read-only details page for a single app-owned Gift With Purchase discount.
// Shopify's admin routes clicks on an app discount to the path configured in
// the gift-with-purchase-discount function TOML ([extensions.ui.paths]
// details = "/app/gwp-discount/:id"), substituting :id with the discount id.
// The page shows the discount's live state alongside the saved config that
// drives it, with activate/deactivate controls and a link into the builder.

const DISCOUNT_DETAILS = `#graphql
  query GwpDiscountDetails($id: ID!) {
    discountNode(id: $id) {
      id
      configMetafield: metafield(namespace: "$app", key: "function-configuration") {
        value
      }
      discount {
        __typename
        ... on DiscountAutomaticApp {
          title
          status
          startsAt
          endsAt
          asyncUsageCount
          createdAt
          updatedAt
          discountClasses
          combinesWith {
            orderDiscounts
            productDiscounts
            shippingDiscounts
          }
          appDiscountType {
            functionId
            app { title }
          }
          context {
            __typename
            ... on DiscountCustomers {
              customers { id displayName email }
            }
            ... on DiscountCustomerSegments {
              segments { id name }
            }
          }
        }
      }
    }
    shop { ianaTimezone myshopifyDomain }
  }
`;

const GIFT_PRODUCTS = `#graphql
  query GwpDiscountGiftProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id
        title
        featuredImage { url altText }
      }
      ... on ProductVariant {
        id
        title
        image { url altText }
        product { title featuredImage { url altText } }
      }
    }
  }
`;

const DISCOUNT_ACTIVATE = `#graphql
  mutation GwpDiscountActivate($id: ID!) {
    discountAutomaticActivate(id: $id) {
      userErrors { field message }
    }
  }
`;

const DISCOUNT_DEACTIVATE = `#graphql
  mutation GwpDiscountDeactivate($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      userErrors { field message }
    }
  }
`;

// The :id token from the TOML details path arrives as a bare numeric id;
// accept a full gid too in case the page is linked to directly.
function toDiscountGid(param) {
  const raw = String(param || "").trim();
  if (raw.startsWith("gid://")) return raw;
  const numeric = raw.replace(/[^0-9]/g, "");
  return numeric ? `gid://shopify/DiscountAutomaticNode/${numeric}` : null;
}

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const gid = toDiscountGid(params.id);
  if (!gid) {
    return json({ found: false, discountParam: params.id });
  }

  let data;
  try {
    data = await gql(admin, DISCOUNT_DETAILS, { id: gid });
  } catch (err) {
    console.error("GWP discount details lookup failed", err);
    return json({ found: false, discountParam: params.id });
  }

  const node = data?.discountNode;
  const discount = node?.discount;
  if (!node?.id || discount?.__typename !== "DiscountAutomaticApp") {
    return json({ found: false, discountParam: params.id });
  }

  // The saved builder config that owns this discount (if it still exists).
  const row = await prisma.gwpAppV1Config.findFirst({
    where: { shop: session.shop, discountId: node.id },
  });
  let config = null;
  if (row) {
    try {
      config = JSON.parse(row.configJson);
    } catch {
      config = null;
    }
  }

  // Prefer the live payload on the discount metafield (what the function
  // actually reads); fall back to rebuilding it from the saved config.
  let fnConfig = null;
  try {
    fnConfig = JSON.parse(node.configMetafield?.value || "null")?.configs?.[0] ?? null;
  } catch {
    fnConfig = null;
  }
  if (!fnConfig && config) fnConfig = buildFunctionConfig(config);

  // Resolve gift product/variant gids to titles + images for display.
  let gifts = [];
  const giftIds = [
    ...(fnConfig?.productIds || []),
    ...(fnConfig?.variantIds || []),
  ].slice(0, 20);
  if (giftIds.length) {
    try {
      const giftData = await gql(admin, GIFT_PRODUCTS, { ids: giftIds });
      gifts = (giftData?.nodes || [])
        .filter(Boolean)
        .map((n) =>
          n.__typename === "ProductVariant"
            ? {
                id: n.id,
                title: `${n.product?.title || "Product"} - ${n.title}`,
                image: n.image?.url || n.product?.featuredImage?.url || null,
              }
            : {
                id: n.id,
                title: n.title,
                image: n.featuredImage?.url || null,
              },
        );
    } catch (err) {
      console.error("GWP gift product lookup failed", err);
    }
  }

  const context = discount.context;
  const eligibility =
    context?.__typename === "DiscountCustomers"
      ? {
          type: "customers",
          items: (context.customers || []).map(
            (c) => c.displayName || c.email || c.id,
          ),
        }
      : context?.__typename === "DiscountCustomerSegments"
        ? {
            type: "segments",
            items: (context.segments || []).map((s) => s.name || s.id),
          }
        : { type: "all", items: [] };

  const numericId = node.id.match(/\/(\d+)$/)?.[1] ?? null;
  return json({
    found: true,
    discountId: node.id,
    shopTimeZone: data?.shop?.ianaTimezone || null,
    adminDiscountUrl: numericId
      ? `https://${data?.shop?.myshopifyDomain}/admin/discounts/${numericId}`
      : null,
    discount: {
      title: discount.title,
      status: discount.status,
      startsAt: discount.startsAt,
      endsAt: discount.endsAt,
      usageCount: discount.asyncUsageCount ?? 0,
      createdAt: discount.createdAt,
      updatedAt: discount.updatedAt,
      combinesWith: discount.combinesWith || {},
      appTitle: discount.appDiscountType?.app?.title || null,
    },
    eligibility,
    config: config
      ? {
          rowId: row.id,
          name: row.name || null,
          triggerType: String(config.trigger_type || "min_spend"),
          discountPercentage: fnConfig?.discount_percentage ?? null,
          thresholds: fnConfig?.thresholds || {},
          maxTotalUses: Number(config.max_total_uses || 0) || null,
          enabled: config.enabled !== false,
          mode: String(config.mode || "live"),
          label: config.label || config.admin_title || null,
        }
      : null,
    fnConfig: fnConfig
      ? {
          triggerType: fnConfig.trigger_type,
          discountPercentage: fnConfig.discount_percentage,
          thresholds: fnConfig.thresholds || {},
          message: fnConfig.message || null,
        }
      : null,
    gifts,
  });
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const gid = toDiscountGid(params.id);
  if (!gid) return json({ error: "Unknown discount." }, { status: 400 });

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent !== "activate" && intent !== "deactivate") {
    return json({ error: "Unknown action." }, { status: 400 });
  }

  const mutation = intent === "activate" ? DISCOUNT_ACTIVATE : DISCOUNT_DEACTIVATE;
  const key =
    intent === "activate" ? "discountAutomaticActivate" : "discountAutomaticDeactivate";
  try {
    const data = await gql(admin, mutation, { id: gid });
    const errors = data?.[key]?.userErrors ?? [];
    if (errors.length) {
      return json(
        { error: errors.map((e) => e.message).join(", ") },
        { status: 400 },
      );
    }
  } catch (err) {
    return json({ error: String(err.message || err) }, { status: 500 });
  }
  return json({ ok: true });
};

function statusLabel(status) {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "EXPIRED":
      return "Deactivated";
    case "SCHEDULED":
      return "Scheduled";
    default:
      return "Unknown";
  }
}

function statusTone(status) {
  if (status === "ACTIVE") return "success";
  if (status === "SCHEDULED") return "attention";
  return undefined;
}

function triggerLabel(value) {
  return TRIGGER_TYPES.find((t) => t.value === value)?.label || value;
}

function formatDateTime(iso, timeZone) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function DetailRow({ label, children }) {
  return (
    <InlineStack align="space-between" blockAlign="start" gap="400">
      <Text as="span" tone="subdued">
        {label}
      </Text>
      <Box maxWidth="60%">
        <Text as="span" alignment="end">
          {children}
        </Text>
      </Box>
    </InlineStack>
  );
}

export default function GwpDiscountDetails() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  if (!data.found) {
    return (
      <Page
        title="Discount not found"
        backAction={{ content: "Gift with purchase", url: "/app/gift-with-purchase" }}
      >
        <TitleBar title="Discount not found" />
        <Layout>
          <Layout.Section>
            <Banner tone="warning" title="This discount could not be loaded">
              <p>
                It may have been deleted, or it is not one of the Gift With
                Purchase discounts managed by this app. You can review all
                offers on the{" "}
                <Link url="/app/gift-with-purchase">Gift with purchase</Link>{" "}
                page.
              </p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const { discount, config, fnConfig, gifts, eligibility, shopTimeZone } = data;
  const isActive = discount.status === "ACTIVE";
  const combos = [
    discount.combinesWith.orderDiscounts && "Order discounts",
    discount.combinesWith.productDiscounts && "Other product discounts",
    discount.combinesWith.shippingDiscounts && "Shipping discounts",
  ].filter(Boolean);
  const thresholds = fnConfig?.thresholds || config?.thresholds || {};
  const thresholdEntries = SUPPORTED_CURRENCIES.filter(
    (c) => thresholds[c] != null,
  ).map((c) => `${c} ${thresholds[c]}`);
  const usesMinSpend = triggerUsesMinSpend(
    fnConfig?.triggerType || config?.triggerType,
  );

  return (
    <Page
      title={discount.title}
      titleMetadata={
        <Badge tone={statusTone(discount.status)}>
          {statusLabel(discount.status)}
        </Badge>
      }
      backAction={{ content: "Gift with purchase", url: "/app/gift-with-purchase" }}
      secondaryActions={[
        {
          content: isActive ? "Deactivate" : "Activate",
          destructive: isActive,
          loading: busy,
          onAction: () =>
            fetcher.submit(
              { intent: isActive ? "deactivate" : "activate" },
              { method: "post" },
            ),
        },
      ]}
    >
      <TitleBar title={discount.title} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {fetcher.data?.error ? (
              <Banner tone="critical" title="That didn't work">
                <p>{fetcher.data.error}</p>
              </Banner>
            ) : null}

            {!config ? (
              <Banner tone="warning" title="No saved offer found for this discount">
                <p>
                  This discount was created by the app, but no saved Gift With
                  Purchase config currently points at it. It may belong to a
                  deleted offer.
                </p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Discount
                </Text>
                <Divider />
                <DetailRow label="Status">{statusLabel(discount.status)}</DetailRow>
                <DetailRow label="Starts">
                  {formatDateTime(discount.startsAt, shopTimeZone) || "-"}
                </DetailRow>
                <DetailRow label="Ends">
                  {formatDateTime(discount.endsAt, shopTimeZone) || "No end date"}
                </DetailRow>
                <DetailRow label="Times used">
                  {config?.maxTotalUses
                    ? `${discount.usageCount} of ${config.maxTotalUses}`
                    : String(discount.usageCount)}
                </DetailRow>
                <DetailRow label="Combines with">
                  {combos.length ? combos.join(", ") : "No other discounts"}
                </DetailRow>
                <DetailRow label="Customer eligibility">
                  {eligibility.type === "all"
                    ? "All customers"
                    : eligibility.items.slice(0, 5).join(", ") +
                      (eligibility.items.length > 5
                        ? ` and ${eligibility.items.length - 5} more`
                        : "")}
                </DetailRow>
                <DetailRow label="Last updated">
                  {formatDateTime(discount.updatedAt, shopTimeZone) || "-"}
                </DetailRow>
              </BlockStack>
            </Card>

            {fnConfig || config ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Offer
                  </Text>
                  <Divider />
                  <DetailRow label="Trigger">
                    {triggerLabel(fnConfig?.triggerType || config?.triggerType)}
                  </DetailRow>
                  {usesMinSpend && thresholdEntries.length ? (
                    <DetailRow label="Minimum spend">
                      {thresholdEntries.join(", ")}
                    </DetailRow>
                  ) : null}
                  <DetailRow label="Gift discount">
                    {`${fnConfig?.discountPercentage ?? config?.discountPercentage ?? 100}% off`}
                  </DetailRow>
                  {fnConfig?.message ? (
                    <DetailRow label="Checkout label">{fnConfig.message}</DetailRow>
                  ) : null}
                  {config ? (
                    <DetailRow label="Mode">
                      {config.mode === "test" ? "Test" : "Live"}
                      {config.enabled ? "" : " (disabled)"}
                    </DetailRow>
                  ) : null}
                  {gifts.length ? (
                    <BlockStack gap="200">
                      <Text as="span" tone="subdued">
                        Gift products
                      </Text>
                      {gifts.map((g) => (
                        <InlineStack key={g.id} gap="300" blockAlign="center">
                          <Thumbnail
                            source={g.image || ""}
                            alt={g.title}
                            size="small"
                          />
                          <Text as="span">{g.title}</Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  ) : null}
                </BlockStack>
              </Card>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Manage
                </Text>
                <Text as="p" tone="subdued">
                  This discount is created and kept in sync by the Gift With
                  Purchase app. Edit the offer in the builder - changes to the
                  offer update this discount automatically.
                </Text>
                <InlineStack gap="300">
                  {config ? (
                    <Button
                      url={`/app/gift-with-purchase?config=${encodeURIComponent(config.rowId)}`}
                      variant="primary"
                    >
                      Edit this offer in the builder
                    </Button>
                  ) : null}
                  <Button url="/app/gift-with-purchase">
                    All Gift with purchase offers
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
