import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  InlineStack,
  Link,
  Badge,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

// Admin pages that ship with this app (matches the nav menu in app.jsx).
const ADMIN_PAGES = [
  {
    title: "Cart transform",
    url: "/app/cart-transform",
    description:
      "Install/uninstall the lubricant bundle cart transform, sync the bundle index metafield, and verify or repair bundle definitions.",
  },
  {
    title: "PO/AFO/FPO delivery",
    url: "/app/po-box-delivery",
    description:
      "Manage the PO Box / APO / FPO delivery customization: install, configure restrictions, and uninstall.",
  },
  {
    title: "Lingerie set sync",
    url: "/app/lingerie-set-sync",
    description:
      "Auto-populate lingerie set metaobjects by finding parent set products and writing component references to their child items.",
  },
  {
    title: "Gift with purchase",
    url: "/app/gift-with-purchase",
    description:
      "Build any number of gift/purchase-with-purchase offers (min spend, subscription, or buy X get Y) across seven currencies. Each renders a progress banner and label in checkout and discounts the gift line via the gift-with-purchase-discount function.",
  },
  {
    title: "Kibo Checker",
    url: "/app/kibo-checker",
    description:
      "Detect Shopify orders missing from Kibo via a reconciliation sweep, then batch reimport or recheck their sync status.",
  },
  {
    title: "Client info cleanup",
    url: "/app/client-info-cleanup",
    description:
      "Search recent orders and strip stale `_client_info` cart attributes left behind at checkout.",
  },
];

// Shopify Functions registered as extensions.
const FUNCTIONS = [
  {
    name: "bundle-discount / bundle-discount-v2",
    type: "Product discount",
    description:
      "Apply multi-currency bundle discounts based on product tags, reading bundle config from a metafield. Configured via the bundle-discount UI.",
  },
  {
    name: "discount-rejection-function-js",
    type: "Product discount",
    description:
      "Reject automatic discounts based on merchant-configured rules from the discount-rejection UI.",
  },
  {
    name: "reject-discount-codes-for-staff-function",
    type: "Product discount",
    description:
      "Block discounts for staff (honeybirdette.com.au / honeybirdette.com emails or the staff tag).",
  },
  {
    name: "gift-with-purchase-discount",
    type: "Product discount",
    description:
      "Make the gift line free (or % off) for offers built on the Gift with purchase page, gating min-spend offers on the per-currency subtotal threshold.",
  },
  {
    name: "free-standard-shipping-for-staff",
    type: "Delivery discount",
    description:
      "Offer free standard shipping to staff, using a shipping title configured in its settings UI.",
  },
  {
    name: "update-po-apo-fpo-boxes",
    type: "Delivery transform",
    description:
      "Filter and transform delivery options for PO Box, APO, and FPO addresses. Managed from the PO/AFO/FPO delivery page.",
  },
  {
    name: "block-toys-and-bondage-function",
    type: "Cart validation",
    description:
      "Block checkout when Toys or Bondage products ship to restricted countries or Alabama. Paired with the block-toys-and-bondage UI.",
  },
  {
    name: "block-discount-codes-with-gift-cards",
    type: "Cart validation",
    description: "Reject discount codes when a gift card is present in the cart.",
  },
  {
    name: "limit-1",
    type: "Cart validation",
    description:
      "Enforce a single-quantity limit on specified products. Paired with the limit-1 checkout UI.",
  },
  {
    name: "quantity-10-limit",
    type: "Cart validation",
    description: "Cap the maximum quantity at 10 per line item.",
  },
  {
    name: "lubricant-bundle-transform",
    type: "Cart transform",
    description:
      "Auto-add or remove bundle component variants when a parent variant changes. Managed from the Cart transform page.",
  },
];

// Checkout UI extensions.
const CHECKOUT_EXTENSIONS = [
  {
    name: "block-toys-and-bondage",
    description:
      "Block checkout when restricted Toys/Bondage products ship to restricted regions or Alabama.",
  },
  {
    name: "consent-to-checkout",
    description:
      "US consent gate requiring customers to accept terms before proceeding.",
  },
  {
    name: "countdown-timer",
    description:
      "Time-sensitive banner showing different text before and after a configured date.",
  },
  {
    name: "checkout-recommendations",
    description:
      "Product recommendations sourced from metaobjects or Shopify's recommendation API, with free-shipping thresholds.",
  },
  {
    name: "giftbox-upsell",
    description: "Single-variant gift box upsell at checkout.",
  },
  {
    name: "help-banner",
    description:
      "Customizable help/support banner with an optional contact link.",
  },
  {
    name: "image-banner",
    description: "Responsive desktop/mobile banner with an optional link.",
  },
  {
    name: "limit-1-ui",
    description:
      "Companion UI to the limit-1 validation that holds specified products to a quantity of one.",
  },
  {
    name: "gift-with-purchase",
    description:
      "Multi-offer gift/purchase-with-purchase system. Renders one progress banner with a label per enabled config (min spend, subscription, or buy X get Y) across seven currencies, and auto-adds the gift line.",
  },
  {
    name: "message-banner",
    description:
      "Flexible banner with title, description, status badge, and collapsible content.",
  },
  {
    name: "product-upsell",
    description: "Single-variant upsell with a gift-with-purchase flag.",
  },
  {
    name: "product-upsells / product-upsells-V2",
    description:
      "Multi-product upsell (up to 4 variants) with per-product GWP/giftbox flags; V2 adds network access.",
  },
  {
    name: "reject-discount-codes-for-staff",
    description:
      "Block staff accounts from applying manual discount codes at checkout.",
  },
  {
    name: "remove-client-info",
    description: "Silently strip the stale `_client_info` cart attribute.",
  },
  {
    name: "mexico-tax-number-input",
    description:
      "Capture the RFC tax ID after the shipping address when Mexico is selected.",
  },
];

// Customer account UI extensions.
const CUSTOMER_ACCOUNT_EXTENSIONS = [
  {
    name: "ca-image-banner",
    description:
      "Responsive banner on the profile, order-status, and order-index pages with an optional link.",
  },
  {
    name: "omeno-birthday-banner",
    description:
      "Birthday banner on customer account pages, reading birthday and tag metafields.",
  },
];

function ItemRow({ name, type, description }) {
  return (
    <BlockStack gap="100">
      <InlineStack gap="200" blockAlign="center">
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {name}
        </Text>
        {type && <Badge tone="info">{type}</Badge>}
      </InlineStack>
      <Text as="p" variant="bodyMd" tone="subdued">
        {description}
      </Text>
    </BlockStack>
  );
}

function ItemList({ items }) {
  return (
    <BlockStack gap="400">
      {items.map((item, index) => (
        <BlockStack gap="400" key={item.name}>
          {index > 0 && <Divider />}
          <ItemRow {...item} />
        </BlockStack>
      ))}
    </BlockStack>
  );
}

export default function Index() {
  return (
    <Page>
      <TitleBar title="Checkout app overview" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Honey Birdette checkout customizations
                  </Text>
                  <Text as="p" variant="bodyMd">
                    This app bundles the checkout UI extensions, Shopify
                    Functions, and admin pages that customize the Honey Birdette
                    storefront checkout and customer account experience. Use the
                    pages below to configure the parts that have settings, and
                    refer to the lists for everything else that is deployed.
                  </Text>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Admin pages
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Interactive pages in this app, also reachable from the nav
                    menu.
                  </Text>
                  <BlockStack gap="400">
                    {ADMIN_PAGES.map((page, index) => (
                      <BlockStack gap="400" key={page.url}>
                        {index > 0 && <Divider />}
                        <BlockStack gap="100">
                          <Link url={page.url} removeUnderline>
                            {page.title}
                          </Link>
                          <Text as="p" variant="bodyMd" tone="subdued">
                            {page.description}
                          </Text>
                        </BlockStack>
                      </BlockStack>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Shopify Functions
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Server-side functions for discounts, delivery, validation,
                    and cart transforms.
                  </Text>
                  <ItemList items={FUNCTIONS} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Checkout UI extensions
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    UI rendered inside the storefront checkout.
                  </Text>
                  <ItemList items={CHECKOUT_EXTENSIONS} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Customer account UI extensions
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    UI rendered in the customer account area.
                  </Text>
                  <ItemList items={CUSTOMER_ACCOUNT_EXTENSIONS} />
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    At a glance
                  </Text>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Admin pages
                      </Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {ADMIN_PAGES.length}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Shopify Functions
                      </Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {FUNCTIONS.length}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Checkout extensions
                      </Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {CHECKOUT_EXTENSIONS.length}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Customer account extensions
                      </Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {CUSTOMER_ACCOUNT_EXTENSIONS.length}
                      </Text>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Reference
                  </Text>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Framework
                      </Text>
                      <Link url="https://remix.run" target="_blank" removeUnderline>
                        Remix
                      </Link>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Checkout UI
                      </Text>
                      <Link
                        url="https://shopify.dev/docs/api/checkout-ui-extensions"
                        target="_blank"
                        removeUnderline
                      >
                        UI extensions
                      </Link>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Functions
                      </Text>
                      <Link
                        url="https://shopify.dev/docs/api/functions"
                        target="_blank"
                        removeUnderline
                      >
                        Shopify Functions
                      </Link>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
