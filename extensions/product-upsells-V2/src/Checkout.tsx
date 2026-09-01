import React, { useEffect, useState } from "react";
import {
  reactExtension,
  ScrollView,
  Divider,
  ProductThumbnail,
  Banner,
  Heading,
  Button,
  InlineLayout,
  BlockStack,
  Text,
  Grid,
  GridItem,
  View,
  TextBlock,
  Image,
  InlineSpacer,
  SkeletonText,
  SkeletonImage,
  Modal,
  Pressable,
  useCartLines,
  useApplyCartLinesChange,
  useApi,
  useAttributes,
  useCheckoutSettings,
  useSettings,
  useTranslate,
  Style,
  Icon,
  useShop,         
  useShippingAddress,
  useDeliveryGroups,
} from "@shopify/ui-extensions-react/checkout";

// Set up the entry point for the extension
export default reactExtension("purchase.checkout.block.render", () => <App />);

// ---------------------------------------------------------------------------
// Variant / size picker helpers (ported from checkout-recommendations)
// ---------------------------------------------------------------------------

// Shopify represents single-variant products with one synthetic "Title /
// Default Title" option; we hide it so those products skip the picker.
const isDefaultOption = (option) =>
  String(option?.name).toLowerCase() === "title" &&
  String(option?.value).toLowerCase() === "default title";

// Reshape the configured variant's product into the picker data: every
// purchasable variant (with its per-option values) plus the option axes
// (e.g. "Bra Size", "Brief Size") so the modal can render a button row per option.
const buildPicker = (variant) => {
  const product = variant?.product || {};
  const allVariants = (product?.variants?.nodes || []).filter((v) => v?.id);
  const available = allVariants.filter((v) => v.availableForSale);

  const variants = available.map((v) => {
    const optionValues = {};
    (v.selectedOptions || []).forEach((o) => {
      if (!isDefaultOption(o)) optionValues[o.name] = o.value;
    });
    return {
      id: v.id,
      price: v.price?.amount ?? "0.00",
      compareAtPrice: v.compareAtPrice?.amount ?? null,
      optionValues,
    };
  });

  const options = [];
  const byName = {};
  available.forEach((v) => {
    (v.selectedOptions || []).forEach((o) => {
      if (isDefaultOption(o)) return;
      if (!byName[o.name]) {
        byName[o.name] = { name: o.name, values: [] };
        options.push(byName[o.name]);
      }
      if (!byName[o.name].values.includes(o.value)) byName[o.name].values.push(o.value);
    });
  });

  const fallbackAlt = product.title || "Product image";
  const imageNodes = [product.featuredImage, ...(product.images?.nodes || [])].filter((n) => n?.url);
  const seenUrls = new Set();
  const images = [];
  imageNodes.forEach((node) => {
    if (seenUrls.has(node.url)) return;
    seenUrls.add(node.url);
    images.push({ url: node.url, alt: node.altText || fallbackAlt });
  });

  return {
    productId: product.id || variant?.id,
    variantId: variant?.id,
    title: product.title || "",
    images,
    variants,
    options,
    // Only open the picker when there is a real choice to make.
    hasOptions: options.length > 0 && variants.length > 1,
  };
};

// Find the available variant matching an option selection (name -> value).
const findVariant = (card, selection) =>
  card.variants.find((v) => card.options.every((o) => v.optionValues[o.name] === selection[o.name]));

// Whether choosing `value` for `option` can still yield an available variant,
// given the buyer's current picks for the OTHER options. Drives button enabling.
const valueIsAvailable = (card, selection, option, value) =>
  card.variants.some(
    (v) =>
      v.optionValues[option.name] === value &&
      card.options.every((o) => o.name === option.name || v.optionValues[o.name] === selection[o.name])
  );

// Apply a single option change, then snap the other options to a real available
// variant so the selection never lands on a non-existent combination.
const reconcileSelection = (card, selection, changedName, changedValue) => {
  const next = { ...selection, [changedName]: changedValue };
  if (findVariant(card, next)) return next;
  const fallback = card.variants.find((v) => v.optionValues[changedName] === changedValue);
  if (fallback) card.options.forEach((o) => { next[o.name] = fallback.optionValues[o.name]; });
  return next;
};

// The buyer's default selection: the option values of the merchant-configured
// variant (falls back to the first available variant if that one sold out).
const defaultSelection = (card) => {
  const variant = card.variants.find((v) => v.id === card.variantId) || card.variants[0];
  const selection = {};
  card.options.forEach((o) => { selection[o.name] = variant?.optionValues[o.name]; });
  return selection;
};

// Append Shopify CDN resize params so each render gets a crisp, right-sized image.
const sizedImage = (url, size) =>
  url
    ? `${url}${url.includes("?") ? "&" : "?"}width=${size}&height=${size}&crop=center`
    : "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png";

function App() {
  const { query, i18n } = useApi();
  // Hide the upsell/giftbox block on draft-order checkouts (merchant-created
  // invoices). Cart lines aren't buyer-editable there, so the "Add" actions
  // wouldn't work. `orderSubmission` is 'DRAFT_ORDER' vs 'ORDER'.
  const checkoutSettings = useCheckoutSettings();
  const isDraftOrder = checkoutSettings?.orderSubmission === "DRAFT_ORDER";
  const { myshopifyDomain } = useShop();
  const shippingAddress = useShippingAddress();
  const applyCartLinesChange = useApplyCartLinesChange();

  const deliveryGroups = useDeliveryGroups();

  // Helper to resolve selected option type from delivery groups
  const isPickupSelectedFromGroups = (groups: any[] | undefined) => {
    if (!groups || groups.length === 0) return false;
    return groups.some((group: any) => {
      const selectedHandle = group?.selectedDeliveryOption?.handle;
      if (!selectedHandle) return false;
      const selected = group.deliveryOptions?.find((opt: any) => opt.handle === selectedHandle);
      const t = selected?.type; // 'shipping' | 'local' | 'pickup' | 'pickupPoint'
      return t === 'pickup' || t === 'pickupPoint';
    });
  };

  const pickupSelected = isPickupSelectedFromGroups(deliveryGroups as any);

  // Store variants in state
  const [variant1, setVariant1] = useState(null);
  const [variant2, setVariant2] = useState(null);
  const [variant3, setVariant3] = useState(null);
  const [variant4, setVariant4] = useState(null);

  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showError, setShowError] = useState(false);
  const [giftboxValid, setGiftboxValid] = useState(true);
  const [loadingGiftCheck, setLoadingGiftCheck] = useState(true);


  // Grab active cart lines and settings
  const lines = useCartLines();

  // Hide on Honey List gift checkouts (Order A). Line items aren't exposed to
  // extensions there (cart lines are empty on a draft-order invoice; `_`-prefixed
  // line attributes are stripped), so key off the order-level `honey_list` marker
  // the Honey List app stamps on the draft (ORDER_ATTR in that app's config).
  // `honey_list` is the purpose-built marker; `hl_*` (e.g. `hl_gift_owner`, which
  // the checkout banner relies on) is always present too. Match either so this
  // fires regardless of which Honey List app version is deployed.
  const orderAttributes = useAttributes();
  const isHoneyListCheckout = (orderAttributes || []).some(
    (a) => a?.key === "honey_list" || (typeof a?.key === "string" && a.key.startsWith("hl_")),
  );
  const {
    // Product 1
    product1,
    product1_is_gwp,
    product1_is_giftbox,
    product1_title,
  
    // Product 2
    product2,
    product2_is_gwp,
    product2_is_giftbox,
    product2_title,
  
    // Product 3
    product3,
    product3_is_gwp,
    product3_is_giftbox,
    product3_title,
  
    // Product 4
    product4,
    product4_is_gwp,
    product4_is_giftbox,
    product4_title,

  
    giftbox_section_title,
    product_section_title,
    scroll_container_height,
  } = useSettings();

  // Provide fallback variant IDs if none are configured in settings
  const variantId1 = product1 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId2 = product2 ?? "gid://shopify/ProductVariant/41816704516211";
  const variantId3 = product3 ?? "gid://shopify/ProductVariant/41816701599859";
  const variantId4 = product4 ?? "gid://shopify/ProductVariant/41816701501555";

// Product 1
const titleSetting1 = product1_title ?? "Upsell Title";
const isGWP1 = product1_is_gwp ?? false;
const isGiftbox1 = product1_is_giftbox ?? false;

// Product 2
const titleSetting2 = product2_title ?? "Upsell Title";
const isGWP2 = product2_is_gwp ?? false;
const isGiftbox2 = product2_is_giftbox ?? true;

// Product 3
const titleSetting3 = product3_title ?? "Upsell Title";
const isGWP3 = product3_is_gwp ?? true;
const isGiftbox3 = product3_is_giftbox ?? false;

// Product 4
const titleSetting4 = product4_title ?? "Upsell Title";
const isGWP4 = product4_is_gwp ?? false;
const isGiftbox4 = product4_is_giftbox ?? false;



useEffect(() => {
  async function checkGiftboxes() {
    // If no giftbox items at all, no need to block anything
    console.log("CHECKING GIFTBOXES")
    let hasNoGiftboxProductTag = false;

    console.log("checkGiftboxes()")
    const anyGiftbox = [
      isGiftbox1,
      isGiftbox2,
      isGiftbox3,
      isGiftbox4,
    ].some(Boolean);

    console.log(anyGiftbox)

    // If we don't even have a giftbox product, skip
    if (!anyGiftbox) {
      setGiftboxValid(true);
      setLoadingGiftCheck(false);
      return;
    }

    // 1) Check for "no-giftbox" tags in cart lines
    try {
      const productIds = lines.map((line) => line.merchandise.product.id);
      if (productIds.length > 0) {
        const response = await query(
          `
          query ($productIds: [ID!]!) {
            nodes(ids: $productIds) {
              ... on Product {
                id
                tags
              }
            }
          }
          `,
          { variables: { productIds } }
        );

        console.log("response")
        console.log(response)
        // If ANY product has "no-giftbox" -> disable giftbox
        const hasNoGiftboxTag = response.data.nodes.some((p) =>
          p?.tags?.includes("no-giftbox")
        );

        hasNoGiftboxProductTag = hasNoGiftboxTag;
      }
    } catch (err) {
      console.error("Error fetching product tags for giftbox:", err);
      // If error, let's be safe and hide giftbox
      setGiftboxValid(true);
      setLoadingGiftCheck(false);
      return;
    }

    var validForGiftBox = false;
    var validShopifyDomain = false;

    if(myshopifyDomain === 'honey-birdette-usa.myshopify.com' && shippingAddress?.countryCode === 'US') {
      validForGiftBox = true;
      validShopifyDomain = true; 
    }

    if(myshopifyDomain === 'honey-birdette-2.myshopify.com' && shippingAddress?.countryCode === 'AU') {
      validForGiftBox = true;
      validShopifyDomain = true;
    }

    if (validShopifyDomain == false) {
      // If ANY product has the no-giftbox tag, disable giftbox and stop.
      setGiftboxValid(false);
      setLoadingGiftCheck(false);
      return;
    }

    console.log(`validForGiftBox:${validForGiftBox}`);
    console.log(`validShopifyDomain:${validShopifyDomain}`);
    // 2) Giftbox logic branching
    if (hasNoGiftboxProductTag || !validShopifyDomain) {
      // If ANY product has the no-giftbox tag, disable giftbox and stop.
      setGiftboxValid(false);
      setLoadingGiftCheck(false);
      return;
    }

    if (validForGiftBox && hasNoGiftboxProductTag === false && validShopifyDomain) {
      console.log("Condition met: honeybirdette US or AU shop and shipping to US or AU");
      try {
        const items = lines.map((item) => ({
          sku: item.merchandise.sku,
          quantity: item.quantity,
        }));

        const deliveryValidatorEndpoint = "https://hb-stores-api-prod.herokuapp.com/check-inventory-v2";

        const reqBody = {
          countryCode: shippingAddress.countryCode,
          items,
        };

        const fetchResp = await fetch(deliveryValidatorEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(reqBody),
        });

        const data = await fetchResp.json();
        const products = data.inventoryData;
        let allProductsValid = true;
        products.forEach((p) => {
          if (!p.isAvailable) {
            console.log("🎁 Product NOT available:", p);
            allProductsValid = false;
          } else {
            console.log("🎁 Product available:", p);
          }
        });

        setGiftboxValid(allProductsValid);
        setLoadingGiftCheck(false);
      } catch (error) {
        console.error("Giftbox inventory check error:", error);
        // If error, default to not showing giftbox
        setGiftboxValid(false);
        setLoadingGiftCheck(false);
      }
    } else if (validShopifyDomain && hasNoGiftboxProductTag === false) {
      // On HB US/AU domains but shipping country doesn't match → default block (conservative)
      setGiftboxValid(false);
      setLoadingGiftCheck(false);
    } else {
      // Not HB US/AU → allow giftbox by default
      console.log("Condition not met: either not honeybirdette US / AU or not shipping to US / AU");
      setGiftboxValid(true);
      setLoadingGiftCheck(false);
    }
  }

  checkGiftboxes();
}, [lines, myshopifyDomain, shippingAddress, query]);

  // If buyer selects Pickup / Ship to store, remove any giftbox lines and hide giftbox offer
  useEffect(() => {
    if (!deliveryGroups) return;

    console.log("deliveryGroups")
    console.log(deliveryGroups)

    const pickupSelected = isPickupSelectedFromGroups(deliveryGroups as any);

    if (!pickupSelected) {
      return;
    }

    // Collect the variant IDs that are configured as giftboxes
    const giftVariantIds: string[] = [
      isGiftbox1 ? variant1?.id : undefined,
      isGiftbox2 ? variant2?.id : undefined,
      isGiftbox3 ? variant3?.id : undefined,
      isGiftbox4 ? variant4?.id : undefined,
    ].filter(Boolean) as string[];

    if (giftVariantIds.length === 0) {
      // Still hide the giftbox offer when pickup is selected
      setGiftboxValid(false);
      return;
    }

    // Find any matching cart lines
    const giftLines = lines.filter((l) => giftVariantIds.includes(l.merchandise.id));

    if (giftLines.length === 0) {
      // Hide the giftbox offer even if not in cart yet
      setGiftboxValid(false);
      return;
    }

    // Remove all giftbox lines one-by-one
    (async () => {
      try {
        for (const gl of giftLines) {
          await applyCartLinesChange({
            type: 'removeCartLine',
            id: gl.id,
            quantity: 1
          });
        }
      } catch (err) {
        console.error('Failed removing giftbox for pickup selection:', err);
      } finally {
        // Ensure UI does not re-offer the giftbox while pickup is selected
        setGiftboxValid(false);
      }
    })();
  }, [deliveryGroups, lines, variant1, variant2, variant3, variant4, isGiftbox1, isGiftbox2, isGiftbox3, isGiftbox4, applyCartLinesChange]);


  useEffect(() => {
    // Fetch all variants in parallel
    async function fetchAll() {
      setLoading(true);
      await Promise.all([
        fetchVariant(variantId1, 1),
        fetchVariant(variantId2, 2),
        fetchVariant(variantId3, 3),
        fetchVariant(variantId4, 4),
      ]);
      setLoading(false);
    }

    fetchAll().catch((err) => {
      console.error("Error fetching variants:", err);
      setLoading(false);
    });
  }, [
    variantId1,
    variantId2,
    variantId3,
    variantId4,
  ]);

  // Hide error banner automatically after 3s
  useEffect(() => {
    if (showError) {
      const timer = setTimeout(() => setShowError(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showError]);

  // “Add to cart” button callback
  async function handleAddToCart(variantId, isGiftboxParam?: boolean, compareAtAmount?: string | number | null) {
    setAdding(true);
    // Block adding gift box when Pickup / Pickup Point is selected
    if (isGiftboxParam && pickupSelected) {
      console.log('Blocking gift box add: pickup/pickupPoint selected');
      setAdding(false);
      return;
    }

    const compareAtNum = Number(compareAtAmount);
    const hasCompareAt = Number.isFinite(compareAtNum) && compareAtNum > 0;
    const compareAtCents = hasCompareAt ? Math.round(compareAtNum * 100) : 0;

    const attributes = [
      { key: "_checkout_upsell", value: "true" },
      { key: "__addSource", value: "Checkout" },
      ...(hasCompareAt
        ? [
            { key: "__originPrice", value: String(compareAtCents) },
            { key: "Original Price", value: i18n.formatCurrency(compareAtNum) },
          ]
        : []),
    ];

    const result = await applyCartLinesChange({
      type: "addCartLine",
      merchandiseId: variantId,
      quantity: 1,
      attributes,
    });
    setAdding(false);

    if (result.type === "error") {
      setShowError(true);
      console.error(result.message);
    }
  }

  // Fetch the product variant from Shopify
  async function fetchVariant(variantId, variantNumber) {
    if (!variantId) return;

    try {
      const response = await query(
        `
        query ($variantId: ID!) {
          node(id: $variantId) {
            ... on ProductVariant {
              id
              title
              price {
                amount
              }
              compareAtPrice {
                amount
              }
              product {
                id
                title
                featuredImage { url altText }
                images(first: 10) {
                  nodes {
                    url
                    altText
                  }
                }
                variants(first: 50) {
                  nodes {
                    id
                    title
                    availableForSale
                    selectedOptions { name value }
                    price { amount }
                    compareAtPrice { amount }
                  }
                }
              }
            }
          }
        }
      `,
        { variables: { variantId } }
      );

      const fetchedVariant = response?.data?.node;
      if (!fetchedVariant) {
        console.error("No variant response found:", response.errors || "Unknown error");
        return;
      }

      switch (variantNumber) {
        case 1:
          setVariant1(fetchedVariant);
          break;
        case 2:
          setVariant2(fetchedVariant);
          break;
        case 3:
          setVariant3(fetchedVariant);
          break;
        case 4:
          setVariant4(fetchedVariant);
          break;
      }
    } catch (error) {
      console.error("Error fetching variant:", error);
    }
  }


  // if (loading) {
  //   return <LoadingSkeleton titleSetting="..." descriptionSetting="..." />;
  // }

  // If we have not loaded any variant data at all, return null
  const variantsLoaded = [
    variant1,
    variant2,
    variant3,
    variant4,
  ].some(Boolean);

  if (!variantsLoaded) {
    return null;
  }

  if (isDraftOrder || isHoneyListCheckout) {
    return null;
  }

  const giftboxIsActive = giftboxValid;

  // Pass the loaded variant objects into ProductOffer
  return (
<ProductOffer
  // Variants
  variant1={variant1}
  variant2={variant2}
  variant3={variant3}
  variant4={variant4}

  giftboxValid={giftboxIsActive}
  cartLines={lines}

  // API/Handlers
  i18n={i18n}
  adding={adding}
  handleAddToCart={handleAddToCart}
  showError={showError}

  // Product 1
  titleSetting1={titleSetting1}
  isGWP1={isGWP1}
  isGiftbox1={isGiftbox1}

  // Product 2
  titleSetting2={titleSetting2}
  isGWP2={isGWP2}
  isGiftbox2={isGiftbox2}

  // Product 3
  titleSetting3={titleSetting3}
  isGWP3={isGWP3}
  isGiftbox3={isGiftbox3}

  // Product 4
  titleSetting4={titleSetting4}
  isGWP4={isGWP4}
  isGiftbox4={isGiftbox4}

  pickupSelected={pickupSelected}
/>
  );
}

// Display a skeleton while we load variants
function LoadingSkeleton({ titleSetting }) {
  const translate = useTranslate();
  return (
    <BlockStack spacing="tight" background="subdued" border="none" padding="none">
      <InlineLayout
        spacing="base"
        padding={["tight", "none", "base", "none"]}
        columns={["fill"]}
        blockAlignment="center"
      >
        <BlockStack spacing="none">
          <InlineLayout
            padding={["none", "none", "tight", "none"]}
            spacing="base"
            columns={["auto", "fill"]}
            blockAlignment="start"
          >
            <Icon source="bag" />
            <Heading level={2}>{titleSetting}</Heading>
          </InlineLayout>
          <TextBlock>
             <Text emphasis="bold" appearance="accent">...</Text>
          </TextBlock>
        </BlockStack>
      </InlineLayout>

      <BlockStack spacing="loose">
        <InlineLayout
          padding={["none", "none", "tight", "none"]}
          spacing="base"
          columns={Style.default(["20%", "80%"]).when({ viewportInlineSize: { min: "small" } }, ["20%", "40%"])}
          blockAlignment="center"
        >
          <View>
            <SkeletonImage aspectRatio={1} size="fill" />
          </View>

          <Button kind="secondary" disabled accessibilityLabel="Add Items to cart">
            {translate("add-to-cart")}
          </Button>
        </InlineLayout>
      </BlockStack>
    </BlockStack>
  );
}
function ProductOffer({
  // --- Variants ---
  variant1,
  variant2,
  variant3,
  variant4,

  giftboxValid,
  cartLines,

  // --- API / Handlers ---
  i18n,
  adding,
  handleAddToCart,
  showError,

  // --- Product 1 ---
  titleSetting1,
  isGWP1,
  isGiftbox1,

  // --- Product 2 ---
  titleSetting2,
  isGWP2,
  isGiftbox2,

  // --- Product 3 ---
  titleSetting3,
  isGWP3,
  isGiftbox3,

  // --- Product 4 ---
  titleSetting4,
  isGWP4,
  isGiftbox4,

  pickupSelected,
}) {
  // We import these from @shopify/ui-extensions-react/checkout
  // (ScrollView, BlockStack, InlineLayout, Heading, etc.)

  // 1. Bundle each product’s data into an array
  const allItems = [
    {
      variant: variant1,
      title: titleSetting1,
      isGWP: isGWP1,
      isGiftbox: isGiftbox1,
    },
    {
      variant: variant2,
      title: titleSetting2,
      isGWP: isGWP2,
      isGiftbox: isGiftbox2,
    },
    {
      variant: variant3,
      title: titleSetting3,
      isGWP: isGWP3,
      isGiftbox: isGiftbox3,
    },
    {
      variant: variant4,
      title: titleSetting4,
      isGWP: isGWP4,
      isGiftbox: isGiftbox4,
    },
  ];

  const filteredItems = allItems.filter((item) => {
    if (!item.variant) return false; // skip if no variant data

    // Hide once ANY variant of the product is in the cart (the buyer may have
    // picked a different size via the picker than the configured variant).
    const productId = item.variant?.product?.id;
    const isInCart = cartLines.some(
      (line) =>
        line.merchandise.id === item.variant.id ||
        (productId && line.merchandise?.product?.id === productId)
    );
    return !isInCart;
  });

  // If nothing left to show, hide extension entirely
  if (filteredItems.length === 0) {
    return null;
  }

  return (
    <BlockStack spacing="base">
    <View><Heading level={2}>You May Also Like</Heading></View>
    <View>
    <ScrollView
      maxBlockSize={400}
      hint={{ type: 'pill', content: 'Scroll for more' }}
      padding="none"
      border="none"
      borderRadius="none"
    >
      <View   border="none"
        padding="none"
        minBlockSize={50}>


        {/* Product upsell section */}
        {filteredItems.length > 0 && (
          <BlockStack spacing="tight">
            
            {filteredItems.map((item, index) => (
              <VariantCard
                key={`product-${index}`}
                variant={item.variant}
                title={item.title}
                isGWP={item.isGWP}
                isGiftbox={item.isGiftbox}
                giftboxValid={giftboxValid}
                pickupSelected={pickupSelected}
                i18n={i18n}
                adding={adding}
                handleAddToCart={handleAddToCart}
              />
            ))}
          </BlockStack>
        )}

        {showError && <ErrorBanner />}
      </View>
    </ScrollView>
    </View>
    </BlockStack>
  );
}

/**
 * Renders each variant’s card: image, title, description, and Add-to-cart button.
 * Incorporates GWP logic if desired (e.g., hide price or show 'FREE').
 */
function VariantCard({
  variant,
  title,
  isGWP,
  isGiftbox,
  giftboxValid,
  pickupSelected,
  i18n,
  adding,
  handleAddToCart
}) {
  const product = variant?.product || {};
  const translate = useTranslate();
  const { ui } = useApi();

  // Size picker data (ported from checkout-recommendations). For products with
  // real options the Add button opens a modal; the buyer's pick drives the price
  // shown on the card and the variant that gets added.
  const card = buildPicker(variant);
  const [selection, setSelection] = useState(() => defaultSelection(card));
  const selected =
    findVariant(card, selection) ||
    card.variants.find((v) => v.id === card.variantId) ||
    card.variants[0];

  const images = (card.images.length ? card.images : [{ url: "", alt: product.title || "Product image" }]).slice(0, 7);
  const [activeImage, setActiveImage] = useState(0);
  const activeIdx = Math.min(activeImage, images.length - 1);
  const mainImage = images[activeIdx];

  const selectedVariantId = card.hasOptions && selected ? selected.id : variant?.id;
  const priceAmount = (card.hasOptions && selected ? selected.price : variant?.price?.amount) || "0.00";
  const compareAtAmount = (card.hasOptions && selected ? selected.compareAtPrice : variant?.compareAtPrice?.amount) || null;
  const imageUrl = images[0]?.url || "";
  // Modal ids must be DOM-safe; product gids contain "/" and ":".
  const modalId = `upsell-${String(card.productId).replace(/[^a-zA-Z0-9]/g, "")}`;

  if (title === "Upsell Title") {
    return null;
  }

  if(giftboxValid === false && isGiftbox) {
    return null;
  }

  const currencySymbols = {
    EUR: '€',
    USD: '$',
    AUD: 'A$',
    NZD: 'NZ$',
    GBP: '£',
    CAD: 'C$'
  };
  const stripCurrency = (s) => s
    .replace(/\b(EUR|USD|AUD|NZD|GBP|CAD)\b/g, (match) => currencySymbols[match])
    .replace(/\s+/g, '');

  // Format the price (If GWP is true, optionally skip or show 'FREE')
  let priceWithSymbol = stripCurrency(i18n.formatCurrency(priceAmount).replace(/\.00$/, ""));

  const compareAtNum = Number(compareAtAmount);
  const isOnSale = !isGWP && Number.isFinite(compareAtNum) && compareAtNum > Number(priceAmount);
  const compareAtWithSymbol = isOnSale
    ? stripCurrency(i18n.formatCurrency(compareAtAmount).replace(/\.00$/, ""))
    : null;

  if (isGWP) {
    // For GWP, you might set formattedPrice = "FREE" or similar:
    priceWithSymbol = "FREE";
  }

  // Provide a fallback image if none is available
  const finalImageUrl = sizedImage(imageUrl, 200);
  const modalImageUrl = sizedImage(mainImage?.url, 600);
  const modalPrice = isGWP ? "FREE" : stripCurrency(i18n.formatCurrency(priceAmount).replace(/\.00$/, ""));
  const addLabel = isGWP ? translate("add-free-gift") : translate("add-to-cart");

  const sizePickerModal = card.hasOptions ? (
    <Modal id={modalId} accessibilityLabel={card.title || title} padding>
      <BlockStack spacing="base">
        {/* Row: product image (left) | title over price (right). */}
        <Grid columns={["fill", "fill"]} spacing="base" blockAlignment="center">
          <Image
            source={modalImageUrl}
            accessibilityDescription={mainImage?.alt || card.title}
            aspectRatio={1}
            fit="cover"
            border="none"
            cornerRadius="base"
          />
          <BlockStack spacing="tight">
            <Text emphasis="bold">{card.title || title}</Text>
            <Text appearance="subdued">{modalPrice}</Text>
          </BlockStack>
        </Grid>

        {/* Tappable thumbnail strip to switch the main image. */}
        {images.length > 1 && (
          <ScrollView direction="inline" padding="none" hint="innerShadow">
            <InlineLayout spacing="tight" columns={images.map(() => 56)} blockAlignment="center">
              {images.map((image, index) => (
                <Pressable
                  key={image.url}
                  onPress={() => setActiveImage(index)}
                  cornerRadius="base"
                  border={index === activeIdx ? "base" : "none"}
                  padding="none"
                  accessibilityLabel={`View image ${index + 1}`}
                >
                  <Image
                    source={sizedImage(image.url, 160)}
                    accessibilityDescription={image.alt}
                    aspectRatio={1}
                    fit="cover"
                    border="none"
                    cornerRadius="base"
                  />
                </Pressable>
              ))}
            </InlineLayout>
          </ScrollView>
        )}

        {/* One row of selector buttons per option (e.g. Size, Cup). */}
        {card.options.map((option) => (
          <BlockStack key={option.name} spacing="tight">
            <Text appearance="subdued">{option.name}</Text>
            <Grid
              columns={Array(Math.min(option.values.length, 4)).fill("fill")}
              spacing="tight"
            >
              {option.values.map((value) => (
                <Button
                  key={value}
                  kind={selection[option.name] === value ? "primary" : "secondary"}
                  disabled={!valueIsAvailable(card, selection, option, value)}
                  onPress={() =>
                    setSelection((prev) => reconcileSelection(card, prev, option.name, value))
                  }
                >
                  {value}
                </Button>
              ))}
            </Grid>
          </BlockStack>
        ))}

        <Button
          kind="primary"
          loading={adding}
          disabled={!selected}
          onPress={() => {
            ui.overlay.close(modalId);
            handleAddToCart(selectedVariantId, isGiftbox, isGWP ? null : compareAtAmount);
          }}
        >
          {addLabel}
        </Button>
      </BlockStack>
    </Modal>
  ) : null;

  // --- Insert isGiftboxDisabled flag here ---
  const isGiftboxDisabled = pickupSelected && isGiftbox;

  return (
    <BlockStack
      background="transparent"
      border="none"
      borderRadius="none"
      padding="none"
      spacing="none"
    >
      <InlineLayout
        spacing="base"
        columns={isGiftboxDisabled ? ["auto", "fill"] : ["auto", "fill", "auto"]}
        blockAlignment="center"
      >
        {/* Image */}
        <View maxInlineSize={64}>
          <Image
            source={finalImageUrl}
            alt={product.title || "Product image"}
            size="fill"
            border="none"
            cornerRadius="base"
          />
        </View>

        {/* Text Info: Title / Desc / Price */}
        <BlockStack spacing="extraTight">
          <InlineLayout
            spacing="tight"
            padding={["none", "none", "none", "none"]}
            columns={["auto", "fill"]}
            blockAlignment="start"
          >
            {isGWP && <Icon source="gift" />}
            <Heading level={3}> {title}</Heading>
          </InlineLayout>

          <TextBlock appearance="subdued">
            <Text appearance="subdued">{priceWithSymbol}</Text>
            {compareAtWithSymbol && (
              <>
                <Text appearance="subdued">{' '}</Text>
                <Text appearance="subdued" accessibilityRole="deletion">{compareAtWithSymbol}</Text>
              </>
            )}
          </TextBlock>

          {/* Insert helper text when giftbox is disabled */}
          {isGiftboxDisabled && (
            <TextBlock appearance="subdued">
              <Text emphasis="bold">Not available for Pickup Orders</Text>
            </TextBlock>
          )}
        </BlockStack>

        {/* Rightmost button/message column, only render if NOT disabled */}
        {!isGiftboxDisabled && (
          <InlineLayout
            spacing="base"
            columns={["fill"]}
            blockAlignment="center"
          >
            {pickupSelected && isGiftbox ? (
              <Text appearance="subdued" emphasis="bold" accessibilityRole="status">
                Not available for Pickup Orders
              </Text>
            ) : (
              card.hasOptions ? (
                // Multi-variant: open the size picker instead of adding blindly.
                <Button kind="secondary" loading={adding} overlay={sizePickerModal}>
                  {addLabel}
                </Button>
              ) : (
                <Button
                  kind="secondary"
                  loading={adding}
                  onPress={() => handleAddToCart(variant.id, isGiftbox, isGWP ? null : compareAtAmount)}
                >
                  {addLabel}
                </Button>
              )
            )}
          </InlineLayout>
        )}
      </InlineLayout>
    </BlockStack>
  );
}

function ErrorBanner() {
  return (
    <Banner status="critical">
      There was an issue adding this product. Please try again.
    </Banner>
  );
}