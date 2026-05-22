import { useEffect, useState, useMemo } from "react";
import {
  reactExtension,
  BlockStack,
  InlineLayout,
  View,
  Text,
  TextBlock,
  Heading,
  Button,
  Image,
  Banner,
  Icon,
  Divider,
  Modal,
  Progress,
  useApi,
  useSettings,
  useCartLines,
  useApplyCartLinesChange,
  useEmail,
  useShop,
  useLanguage,
  useTranslate,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension("purchase.checkout.block.render", () => <TieredGWP />);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TierConfig {
  min_spend_aud: number;
  min_spend_usd?: number;
  min_spend_gbp?: number;
  min_spend_eur?: number;
  min_spend_cad?: number;
  min_spend_nzd?: number;
  min_spend_aed?: number;
  products: string[]; // Shopify product handles
  spend_more?: string;        // e.g. "Spend {{spend_more}} to unlock your gift"
  success?: string;           // e.g. "You've unlocked this tier! Choose a gift"
  next_tier?: string;         // e.g. "Spend {{next_tier}} to unlock the next tier"
  modal_description?: string; // shown inside the All Gifts modal for this tier
}

interface ProductData {
  handle: string;
  title: string;
  imageUrl: string;
  variantId: string;
  price: string;
  compareAtPrice: string | null;
  description: string;
  availableForSale: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  AUD: "$",
  USD: "$",
  GBP: "£",
  EUR: "€",
  NZD: "$",
  CAD: "$",
  AED: "AED ",
};

const GWP_TIER_ATTR = "_gwp_tier";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function formatAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  return `${symbol}${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function TieredGWP() {
  const { query } = useApi();
  const settings = useSettings();
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const buyerEmail = useEmail();
  const shop = useShop();
  const language = useLanguage();
  const t = useTranslate();

  // Parse tiers from three separate settings fields (one per tier)
  const tiers: TierConfig[] = useMemo(() => {
    const raws = [settings.tiers_config1, settings.tiers_config2, settings.tiers_config3];
    return raws
      .map((raw, i) => {
        if (!raw) return null;
        try {
          return JSON.parse(raw as string) as TierConfig;
        } catch (e) {
          console.error(`TieredGWP: invalid tiers_config${i + 1} JSON`, e);
          return null;
        }
      })
      .filter((t): t is TierConfig => Boolean(t));
  }, [settings.tiers_config1, settings.tiers_config2, settings.tiers_config3]);

  // Separate regular lines from GWP lines
  const regularLines = useMemo(
    () => cartLines.filter(line => !line.attributes?.some(a => a.key === GWP_TIER_ATTR)),
    [cartLines]
  );

  // Detect currency from cart
  const currency: string =
    (regularLines[0]?.cost as any)?.totalAmount?.currencyCode ?? "AUD";

  // Cart subtotal (regular items only, excluding free gifts)
  const cartSubtotal: number = useMemo(
    () =>
      regularLines.reduce(
        (sum, line) => sum + parseFloat((line.cost as any)?.totalAmount?.amount ?? "0"),
        0
      ),
    [regularLines]
  );

  // Get min spend threshold for current currency
  const getMinSpend = (tier: TierConfig): number => {
    switch (currency) {
      case "USD": return tier.min_spend_usd ?? tier.min_spend_aud;
      case "GBP": return tier.min_spend_gbp ?? tier.min_spend_aud;
      case "EUR": return tier.min_spend_eur ?? tier.min_spend_aud;
      case "CAD": return tier.min_spend_cad ?? tier.min_spend_aud;
      case "NZD": return tier.min_spend_nzd ?? tier.min_spend_aud;
      case "AED": return tier.min_spend_aed ?? tier.min_spend_aud;
      default:    return tier.min_spend_aud;
    }
  };

  // Highest unlocked tier index (-1 = none unlocked)
  const highestUnlocked: number = useMemo(() => {
    let idx = -1;
    tiers.forEach((tier, i) => {
      if (cartSubtotal >= getMinSpend(tier)) idx = i;
    });
    return idx;
  }, [tiers, cartSubtotal, currency]);


  // Fetched product data keyed by tier index
  const [tierProducts, setTierProducts] = useState<Record<number, ProductData[]>>({});
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(false);

  const staffEmailSetting = settings.staff_email_domain as string | undefined;
  const isStaff = Boolean(
    staffEmailSetting && buyerEmail && buyerEmail.includes(staffEmailSetting)
  );

  // Fetch product details from Storefront API whenever the config changes
  useEffect(() => {
    // Trim handles to avoid whitespace issues from JSON input
    const handles = Array.from(new Set(tiers.flatMap(t => t.products.map(h => h.trim()))));
    if (handles.length === 0) return;

    console.log("TieredGWP: fetching handles", handles);

    let cancelled = false;
    setLoadingProducts(true);

    (async () => {
      const productMap: Record<string, ProductData> = {};

      await Promise.all(
        handles.map(async (handle) => {
          try {
            const res = await query(
              `query ($handle: String!) {
                product(handle: $handle) {
                  title
                  handle
                  description
                  images(first: 1) { nodes { url } }
                  variants(first: 1) {
                    nodes { id availableForSale price { amount currencyCode } compareAtPrice { amount currencyCode } }
                  }
                }
              }`,
              { variables: { handle } }
            );
            const p = (res as any)?.data?.product;
            if (!p) {
              console.warn(`TieredGWP: no product found for handle "${handle}"`);
              return;
            }
            const v = p.variants?.nodes?.[0];
            productMap[handle] = {
              handle: p.handle,
              title: p.title.replace(/ Gift$/i, ""),
              description: p.description ?? "",
              imageUrl: p.images?.nodes?.[0]?.url ?? "",
              variantId: v?.id ?? "",
              price: v?.price?.amount ?? "0",
              compareAtPrice: v?.compareAtPrice?.amount ?? null,
              availableForSale: v?.availableForSale ?? false,
            };
            console.log(`TieredGWP: fetched "${handle}" →`, p.title);
          } catch (err) {
            console.error(`TieredGWP: error fetching "${handle}"`, err);
          }
        })
      );

      if (cancelled) return;

      const byTier: Record<number, ProductData[]> = {};
      tiers.forEach((tier, i) => {
        byTier[i] = tier.products
          .map(h => productMap[h.trim()])
          .filter((p): p is ProductData => Boolean(p) && p.availableForSale);
        console.log(`TieredGWP: tier ${i + 1} products →`, byTier[i].map(p => p.title));
      });
      setTierProducts(byTier);
      setLoadingProducts(false);
    })();

    return () => { cancelled = true; };
  // re-fetch when any tier config changes
  }, [settings.tiers_config1, settings.tiers_config2, settings.tiers_config3]);

  // Find the GWP cart line for a given tier (if already chosen)
  const getGiftLine = (tierIndex: number) =>
    cartLines.find(line =>
      line.attributes?.some(
        a => a.key === GWP_TIER_ATTR && a.value === String(tierIndex + 1)
      )
    );

  // GWP enforcement: runs whenever cart or qualification changes.
  // Rules:
  //  1. Remove any GWP line for a tier the customer hasn't unlocked.
  //  2. A customer may only have 1 free gift at a time — remove any extras beyond the first.
  //  3. If the remaining GWP line somehow has quantity > 1, reduce it to 1.
  useEffect(() => {
    const gwpLines = cartLines.filter(line =>
      line.attributes?.some(a => a.key === GWP_TIER_ATTR)
    );
    if (gwpLines.length === 0) return;

    (async () => {
      // Step 1 — remove wrong-tier lines
      for (const line of gwpLines) {
        const attr = line.attributes?.find(a => a.key === GWP_TIER_ATTR);
        const tierNum = parseInt(attr!.value, 10);
        if (tierNum !== highestUnlocked + 1) {
          await applyCartLinesChange({ type: "removeCartLine", id: line.id, quantity: line.quantity });
        }
      }

      // Step 2 — among correct-tier lines keep only the first, remove duplicates
      const correctTierLines = gwpLines.filter(line => {
        const attr = line.attributes?.find(a => a.key === GWP_TIER_ATTR);
        return parseInt(attr!.value, 10) === highestUnlocked + 1;
      });
      for (let i = 1; i < correctTierLines.length; i++) {
        await applyCartLinesChange({ type: "removeCartLine", id: correctTierLines[i].id, quantity: correctTierLines[i].quantity });
      }

      // Step 3 — if the surviving line has quantity > 1, clamp to 1
      if (correctTierLines.length > 0 && correctTierLines[0].quantity > 1) {
        await applyCartLinesChange({ type: "updateCartLine", id: correctTierLines[0].id, quantity: 1 });
      }
    })();
  }, [highestUnlocked, cartLines]);

  // Build a set of all known GWP variant IDs from loaded tier products
  const gwpVariantIds = useMemo(() => {
    const ids = new Set<string>();
    Object.values(tierProducts).forEach(products =>
      products.forEach(p => ids.add(p.variantId))
    );
    return ids;
  }, [tierProducts]);

  // Remove any GWP product added directly to cart (not via GWP flow) when below threshold
  useEffect(() => {
    if (highestUnlocked >= 0 || gwpVariantIds.size === 0) return;

    const abusiveLines = cartLines.filter(line => {
      const variantId = (line.merchandise as any)?.id;
      return (
        variantId &&
        gwpVariantIds.has(variantId) &&
        !line.attributes?.some(a => a.key === GWP_TIER_ATTR)
      );
    });
    if (abusiveLines.length === 0) return;

    (async () => {
      for (const line of abusiveLines) {
        await applyCartLinesChange({ type: "removeCartLine", id: line.id, quantity: line.quantity });
      }
    })();
  }, [cartLines, highestUnlocked, gwpVariantIds]);

  // Remove any GWP lines if the buyer is identified as staff
  useEffect(() => {
    if (!isStaff) return;
    const gwpLines = cartLines.filter(line =>
      line.attributes?.some(a => a.key === GWP_TIER_ATTR)
    );
    if (gwpLines.length === 0) return;
    (async () => {
      for (const line of gwpLines) {
        await applyCartLinesChange({ type: "removeCartLine", id: line.id, quantity: 1 });
      }
    })();
  }, [isStaff, cartLines]);

  const handleRemove = async (lineId: string) => {
    setAdding(true);
    await applyCartLinesChange({ type: "removeCartLine", id: lineId, quantity: 1 });
    setAdding(false);
  };

  const handleAdd = async (variantId: string, tierIndex: number) => {
    setAdding(true);
    const result = await applyCartLinesChange({
      type: "addCartLine",
      merchandiseId: variantId,
      quantity: 1,
      attributes: [
        { key: GWP_TIER_ATTR, value: String(tierIndex + 1) },
        { key: "_gwp", value: "true" },
        { key: "Free Gift", value: `Your Tier ${tierIndex + 1} Gift` },
      ],
    });
    setAdding(false);
    if ((result as any).type === "error") {
      setAddError(true);
      setTimeout(() => setAddError(false), 4000);
    }
  };

  // --- Gates ---

  if (isStaff) return null;
  if (tiers.length === 0) return null;
  if (regularLines.length === 0) return null;

  // Language gate — only active on honey-birdette-eu store
  const languageSetting = (settings.language as string | undefined)?.toUpperCase();
  if (languageSetting && shop.myshopifyDomain.includes("honey-birdette-eu")) {
    const buyerLang = language.isoCode.toLowerCase().split("-")[0];
    const settingLang = languageSetting.toLowerCase();
    if (buyerLang !== settingLang) return null;
  }

  // --- Render ---

  const nextLockedTier =
    highestUnlocked < tiers.length - 1 ? tiers[highestUnlocked + 1] : null;
  const currentTierGiftInCart = highestUnlocked >= 0 && Boolean(getGiftLine(highestUnlocked));

  return (
    <View>
    <BlockStack spacing="base" cornerRadius="base">
      <Divider />
      {/* Header */}
      <InlineLayout columns={["auto", "fill"]} spacing="tight" blockAlignment="center">
        <Icon source="gift" />
        <Heading level={1}>{(settings.heading as string | undefined) ?? t("heading")}</Heading>
      </InlineLayout>
      {(settings.description as string | undefined) && (
        <TextBlock appearance="subdued">{settings.description as string}</TextBlock>
      )}

      {/* "View all gifts" button — opens tier/product overview modal */}
      <View inlineAlignment="start">
        <Button
          kind="secondary"
          overlay={<AllGiftsModal tiers={tiers} tierProducts={tierProducts} currency={currency} />}
        >
          {t("viewAllGifts")}
        </Button>
      </View>

      {/* Progress bar toward next tier — hidden once a gift has been added to cart */}
      {nextLockedTier && !currentTierGiftInCart && (() => {
        const prevThreshold = highestUnlocked >= 0 ? getMinSpend(tiers[highestUnlocked]) : 0;
        const nextThreshold = getMinSpend(nextLockedTier);
        const range = nextThreshold - prevThreshold;
        const progressValue = Math.min(range, Math.max(0, cartSubtotal - prevThreshold));
        return (
          <BlockStack spacing="extraTight">
            <Text emphasis="bold">
              {highestUnlocked === -1
                ? ((settings.tier_zero_message as string | undefined) ?? t("youreOnTier0"))
                : t("youreOnTier", { tier: highestUnlocked + 1 })}
            </Text>
            <Text appearance="subdued" size="small">
              {nextLockedTier.spend_more
                ? interpolate(nextLockedTier.spend_more, { spend_more: formatAmount(Math.max(0, nextThreshold - cartSubtotal), currency) })
                : t("spendMoreToUnlock", { amount: formatAmount(Math.max(0, nextThreshold - cartSubtotal), currency) })}
            </Text>
            <Progress
              value={progressValue}
              max={range}
              accessibilityLabel={t("spendMoreToUnlock", { amount: formatAmount(Math.max(0, nextThreshold - cartSubtotal), currency) })}
            />
            <View minBlockSize={16} />
          </BlockStack>
        );
      })()}

      {/* "Spend more" message toward next tier
      {nextLockedTier && (
        <Text appearance="subdued" size="small">
          {interpolate(
            nextLockedTier.spend_more ??
              "Spend {{spend_more}} more to unlock your Tier {{tier}} gift",
            {
              spend_more: formatAmount(
                Math.max(0, getMinSpend(nextLockedTier) - cartSubtotal),
                currency
              ),
              tier: String(highestUnlocked + 2),
            }
          )}
        </Text>
      )} */}

      {/* {highestUnlocked >= 0 && <Divider />} */}

      {tiers.map((tier, index) => {
        if (index !== highestUnlocked) return null;

        const products = tierProducts[index] ?? [];
        const giftLine = getGiftLine(index);
        const AnyImage = Image as any;
        const selectedImageUrl = giftLine
          ? `${(giftLine.merchandise as any)?.image?.url}&width=200&crop=center&height=200`
          : null;
        const selectedTitle = (
          (giftLine?.merchandise as any)?.product?.title ??
          (giftLine?.merchandise as any)?.title ?? ""
        ).replace(/ Gift$/i, "");

        return (
          <BlockStack key={index} spacing="tight" background="subdued" padding="base">
            {/* Tier unlocked heading — swaps to added_to_cart_message once a gift is selected */}
            <InlineLayout columns={["auto", "fill"]} spacing="tight" blockAlignment="center">
              <Icon source="checkmark" />
              <Text emphasis="bold">
                {giftLine
                  ? ((settings.added_to_cart_message as string | undefined) ?? tier.success ?? t("tierUnlocked", { tier: index + 1 }))
                  : (tier.success ?? t("tierUnlockedChoose", { tier: index + 1 }))}
              </Text>
            </InlineLayout>

            {/* Next tier teaser */}
            {nextLockedTier && (
              <Text appearance="subdued" size="small">
                {nextLockedTier.next_tier
                  ? interpolate(nextLockedTier.next_tier, { next_tier: formatAmount(Math.max(0, getMinSpend(nextLockedTier) - cartSubtotal), currency) })
                  : t("spendMoreForNextTier", { amount: formatAmount(Math.max(0, getMinSpend(nextLockedTier) - cartSubtotal), currency) })}
              </Text>
            )}

            {giftLine ? (
              /* Selected state — show chosen gift with Change button */
              <View padding="tight" border="base" cornerRadius="base">
                <InlineLayout columns={["auto", "fill", "auto"]} spacing="base" blockAlignment="center">
                  <View maxInlineSize={64}>
                    {selectedImageUrl ? (
                      <AnyImage
                        source={selectedImageUrl}
                        alt={selectedTitle}
                        size="fill"
                        border="none"
                        cornerRadius="base"
                      />
                    ) : (
                      <View background="subdued" minBlockSize={56} minInlineSize={56} borderRadius="base" />
                    )}
                  </View>
                  <BlockStack spacing="extraTight">
                    <Text emphasis="bold">{selectedTitle.toUpperCase()}</Text>
                    <Text appearance="accent" emphasis="bold" size="small">{t("free")}</Text>
                  </BlockStack>
                  <Button
                    kind="plain"
                    loading={adding}
                    onPress={() => handleRemove(giftLine.id)}
                    accessibilityLabel={t("changeFreeGiftAccessibility")}
                  >
                    {t("change")}
                  </Button>
                </InlineLayout>
              </View>
            ) : (
              /* Product picker */
              <BlockStack spacing="tight">
                {loadingProducts ? (
                  <Text appearance="subdued" size="small">{t("loadingGifts")}</Text>
                ) : products.length === 0 ? (
                  <Text appearance="subdued" size="small">{t("noGiftsAvailable")}</Text>
                ) : (
                  products.map(product => (
                    <GiftProductCard
                      key={product.handle}
                      product={product}
                      currency={currency}
                      adding={adding}
                      onAdd={() => handleAdd(product.variantId, index)}
                    />
                  ))
                )}
              </BlockStack>
            )}
          </BlockStack>
        );
      })}

      {addError && (
        <Banner status="critical">
          {t("addError")}
        </Banner>
      )}
      <Divider />
    </BlockStack>
    </View>
  );
}

// ---------------------------------------------------------------------------
// GiftProductCard — shown in the picker before a gift is chosen
// ---------------------------------------------------------------------------

function GiftProductCard({
  product,
  currency,
  adding,
  onAdd,
}: {
  product: ProductData;
  currency: string;
  adding: boolean;
  onAdd: () => void;
}) {
  const t = useTranslate();
  const priceFormatted = product.compareAtPrice
    ? formatAmount(parseFloat(product.compareAtPrice), currency)
    : null;
  // Match the pattern used in product-upsells-V2 which works correctly.
  // Shopify CDN urls from Storefront API always include ?v=... so & is safe.
  const AnyImage = Image as any;
  const imageUrl = product.imageUrl
    ? `${product.imageUrl}&width=200&crop=center&height=200`
    : "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png";

  return (
    <View padding="none">
      <InlineLayout
        columns={["auto", "fill", "auto"]}
        spacing="base"
        blockAlignment="center"
      >
        <View maxInlineSize={64}>
          <AnyImage
            source={imageUrl}
            alt={product.title}
            size="fill"
            border="none"
            cornerRadius="base"
          />
        </View>

        <BlockStack spacing="extraTight">
          <Text emphasis="bold">{product.title.toUpperCase()}</Text>
          <InlineLayout
            columns={["auto", "auto"]}
            spacing="tight"
            blockAlignment="center"
          >
            {priceFormatted && (
              <Text appearance="subdued" size="small">
                {t("was")} {priceFormatted}
              </Text>
            )}
            <Text appearance="accent" emphasis="bold" size="small">
              {t("free")}
            </Text>
          </InlineLayout>
        </BlockStack>

        <Button
          kind="secondary"
          loading={adding}
          onPress={onAdd}
          accessibilityLabel={t("addGiftAccessibility", { title: product.title })}
        >
          {t("add")}
        </Button>
      </InlineLayout>
    </View>
  );
}

// ---------------------------------------------------------------------------
// AllGiftsModal — overview of every tier and its products
// ---------------------------------------------------------------------------

function AllGiftsModal({
  tiers,
  tierProducts,
  currency,
}: {
  tiers: TierConfig[];
  tierProducts: Record<number, ProductData[]>;
  currency: string;
}) {
  const t = useTranslate();
  return (
    <Modal title={t("allGifts")} padding id="gwp-all-gifts">
      <TierPicker tiers={tiers} tierProducts={tierProducts} currency={currency} />
    </Modal>
  );
}

function TierPicker({
  tiers,
  tierProducts,
  currency,
}: {
  tiers: TierConfig[];
  tierProducts: Record<number, ProductData[]>;
  currency: string;
}) {
  const t = useTranslate();
  const [selectedTier, setSelectedTier] = useState(0);
  const products = tierProducts[selectedTier] ?? [];
  const currentTier = tiers[selectedTier];

  const tierMinSpend = (() => {
    switch (currency) {
      case "USD": return currentTier.min_spend_usd ?? currentTier.min_spend_aud;
      case "GBP": return currentTier.min_spend_gbp ?? currentTier.min_spend_aud;
      case "EUR": return currentTier.min_spend_eur ?? currentTier.min_spend_aud;
      default:    return currentTier.min_spend_aud;
    }
  })();

  const modalDescription = currentTier.modal_description
    ? interpolate(currentTier.modal_description, {
        min_spend: formatAmount(tierMinSpend, currency),
      })
    : null;

  return (
    <BlockStack spacing="base">
      {/* Tier selector buttons */}
      <InlineLayout columns={tiers.map(() => "fill") as any} spacing="tight">
        {tiers.map((_, i) => (
          <Button
            key={i}
            kind={selectedTier === i ? "primary" : "secondary"}
            onPress={() => setSelectedTier(i)}
          >
            {t("tier", { number: i + 1 })}
          </Button>
        ))}
      </InlineLayout>

      {modalDescription && <TextBlock appearance="subdued">{modalDescription}</TextBlock>}

      {/* Product list for selected tier */}
      <BlockStack spacing="tight">
        {products.length === 0 ? (
          <Text appearance="subdued" size="small">{t("noProductsConfigured")}</Text>
        ) : (
          products.map(product => (
            <ModalProductRow key={product.handle} product={product} currency={currency} />
          ))
        )}
      </BlockStack>
    </BlockStack>
  );
}

function ModalProductRow({
  product,
  currency,
}: {
  product: ProductData;
  currency: string;
}) {
  const t = useTranslate();
  const AnyImage = Image as any;
  const imageUrl = product.imageUrl
    ? `${product.imageUrl}&width=200&crop=center&height=200`
    : "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png";
  const priceFormatted = product.compareAtPrice
    ? formatAmount(parseFloat(product.compareAtPrice), currency)
    : null;

  return (
    <View padding="tight">
      <InlineLayout columns={["auto", "fill"]} spacing="base" blockAlignment="center">
        <View maxInlineSize={56}>
          <AnyImage source={imageUrl} alt={product.title} size="fill" border="none" cornerRadius="base" />
        </View>
        <BlockStack spacing="extraTight">
          <Text emphasis="bold">{product.title.toUpperCase()}</Text>
          <InlineLayout columns={["auto", "auto"]} spacing="tight" blockAlignment="center">
            {priceFormatted && <Text appearance="subdued" size="small">{t("was")} {priceFormatted}</Text>}
            <Text emphasis="bold" size="small">{t("free")}</Text>
          </InlineLayout>
        </BlockStack>
      </InlineLayout>
    </View>
  );
}
