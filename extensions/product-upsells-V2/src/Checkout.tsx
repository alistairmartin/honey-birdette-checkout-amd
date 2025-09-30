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
  useCartLines,
  useApplyCartLinesChange,
  useApi,
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

function App() {
  const { query, i18n } = useApi();
  const { myshopifyDomain } = useShop();
  const shippingAddress = useShippingAddress();
  const applyCartLinesChange = useApplyCartLinesChange();

  const deliveryGroups = useDeliveryGroups();

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

    // Determine if any delivery group is set to Pickup or Pickup Point ("Shipping to pickup points")
    const pickupSelected = deliveryGroups.some((group) => {
      const opt = group?.selectedDeliveryOption as any;
      const t = opt?.type; // 'shipping' | 'local' | 'pickup' | 'pickupPoint'
      return t === 'pickup' || t === 'pickupPoint';
    });

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
  async function handleAddToCart(variantId) {
    setAdding(true);
    const result = await applyCartLinesChange({
      type: "addCartLine",
      merchandiseId: variantId,
      quantity: 1,
      attributes: [{ key: "_checkout_upsell", value: "true" }],
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
              product {
                title
                images(first: 1) {
                  nodes {
                    url
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

    console.log(item)
    const isInCart = cartLines.some(
      (line) => line.merchandise.id === item.variant.id
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
  i18n,
  adding,
  handleAddToCart
}) {
  const product = variant?.product || {};
  const variantTitle = variant?.title || "";
  const priceAmount = variant?.price?.amount || "0.00";
  const imageUrl = product?.images?.nodes?.[0]?.url || "";
  const translate = useTranslate();

  if (title === "Upsell Title") {
    return null;
  }

  if(giftboxValid === false && isGiftbox) {
    return null;
  }

  // Format the price (If GWP is true, optionally skip or show 'FREE')
    let formattedPrice = i18n.formatCurrency(priceAmount).replace(/\.00$/, "");
    const currencySymbols = {
      EUR: '€',
      USD: '$',
      AUD: 'A$',
      NZD: 'NZ$',
      GBP: '£',
      CAD: 'C$'
  };
  let priceWithSymbol = formattedPrice
    .replace(/\b(EUR|USD|AUD|NZD|GBP|CAD)\b/g, (match) => currencySymbols[match])
    .replace(/\s+/g, ''); 
    
  if (isGWP) {
    // For GWP, you might set formattedPrice = "FREE" or similar:
    priceWithSymbol = "FREE"; 
  }

  // Provide a fallback image if none is available
  const finalImageUrl = imageUrl
    ? `${imageUrl}&width=200&crop=center&height=200`
    : "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png";

  return (
    <BlockStack 
      background="transparent"
      border="none"
      borderRadius="none"
      padding="none"
      spacing="none"
    >
      <InlineLayout spacing="base" columns={["auto", "fill", "auto"]} blockAlignment="center">
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
          </TextBlock>

        </BlockStack>

        <InlineLayout
          spacing="base"
          columns={["fill"]}
          blockAlignment="center"
          >
            <Button
              kind={isGWP ? "secondary" : "secondary" }
              loading={adding}
              onPress={() => handleAddToCart(variant.id)}
            >
              {isGWP ? translate('add-free-gift') : translate('add-to-cart') }
            </Button>
        </InlineLayout>
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