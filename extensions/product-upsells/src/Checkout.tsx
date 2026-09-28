import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useCartLines,
  useSettings,
  useTranslate,
  useShop,
  useShippingAddress,
} from "@shopify/ui-extensions/checkout/preact";

// Container width (px) above which the card uses the wide layout (button on the right).
// Replaces the legacy viewport breakpoint `viewportInlineSize: { min: "small" }`.
const WIDE_LAYOUT_MIN = "450px";

// Set up the entry point for the extension
export default function extension() {
  render(<App />, document.body);
}

function App() {
  const { i18n } = shopify;
  const { myshopifyDomain } = useShop();
  const shippingAddress = useShippingAddress();

  // Store variants in state
  const [variant1, setVariant1] = useState(null);
  const [variant2, setVariant2] = useState(null);
  const [variant3, setVariant3] = useState(null);
  const [variant4, setVariant4] = useState(null);
  const [variant5, setVariant5] = useState(null);

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
    product1_description,
  
    // Product 2
    product2,
    product2_is_gwp,
    product2_is_giftbox,
    product2_title,
    product2_description,
  
    // Product 3
    product3,
    product3_is_gwp,
    product3_is_giftbox,
    product3_title,
    product3_description,
  
    // Product 4
    product4,
    product4_is_gwp,
    product4_is_giftbox,
    product4_title,
    product4_description,
  
    // Product 5
    product5,
    product5_is_gwp,
    product5_is_giftbox,
    product5_title,
    product5_description,
  
    giftbox_section_title,
    product_section_title,
    scroll_container_height,
  } = useSettings();

  // Provide fallback variant IDs if none are configured in settings
  const variantId1 = product1 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId2 = product2 ?? "gid://shopify/ProductVariant/41816704516211";
  const variantId3 = product3 ?? "gid://shopify/ProductVariant/41816701599859";
  const variantId4 = product4 ?? "gid://shopify/ProductVariant/41816701501555";
  const variantId5 = product5 ?? "gid://shopify/ProductVariant/41816694947955";

// Product 1
const titleSetting1 = product1_title ?? "Upsell Title";
const descriptionSetting1 = product1_description ?? "Upsell Description.";
const isGWP1 = product1_is_gwp ?? false;
const isGiftbox1 = product1_is_giftbox ?? false;

// Product 2
const titleSetting2 = product2_title ?? "Upsell Title";
const descriptionSetting2 = product2_description ?? "Upsell Description.";
const isGWP2 = product2_is_gwp ?? false;
const isGiftbox2 = product2_is_giftbox ?? true;

// Product 3
const titleSetting3 = product3_title ?? "Upsell Title";
const descriptionSetting3 = product3_description ?? "Upsell Description.";
const isGWP3 = product3_is_gwp ?? true;
const isGiftbox3 = product3_is_giftbox ?? false;

// Product 4
const titleSetting4 = product4_title ?? "Upsell Title";
const descriptionSetting4 = product4_description ?? "Upsell Description.";
const isGWP4 = product4_is_gwp ?? false;
const isGiftbox4 = product4_is_giftbox ?? false;

// Product 5
const titleSetting5 = product5_title ?? "Upsell Title";
const descriptionSetting5 = product5_description ?? "Upsell Description.";
const isGWP5 = product5_is_gwp ?? false;
const isGiftbox5 = product5_is_giftbox ?? false;



useEffect(() => {
  async function checkGiftboxes() {
    // // If no giftbox items at all, no need to block anything

    // let hasNoGiftboxProductTag = false;

    // console.log("checkGiftboxes()")
    // const anyGiftbox = [
    //   isGiftbox1,
    //   isGiftbox2,
    //   isGiftbox3,
    //   isGiftbox4,
    //   isGiftbox5,
    // ].some(Boolean);

    // console.log(anyGiftbox)

    // // If we don't even have a giftbox product, skip
    // if (!anyGiftbox) {
    //   setGiftboxValid(true);
    //   setLoadingGiftCheck(false);
    //   return;
    // }

    // // 1) Check for "no-giftbox" tags in cart lines
    // try {
    //   const productIds = lines.map((line) => line.merchandise.product.id);
    //   if (productIds.length > 0) {
    //     const response = await query(
    //       `
    //       query ($productIds: [ID!]!) {
    //         nodes(ids: $productIds) {
    //           ... on Product {
    //             id
    //             tags
    //           }
    //         }
    //       }
    //       `,
    //       { variables: { productIds } }
    //     );

    //     console.log("response")
    //     console.log(response)
    //     // If ANY product has "no-giftbox" -> disable giftbox
    //     const hasNoGiftboxTag = response.data.nodes.some((p) =>
    //       p?.tags?.includes("no-giftbox")
    //     );

    //     hasNoGiftboxProductTag = hasNoGiftboxTag;

    //     console.log(`hasNoGiftboxTag: ${hasNoGiftboxTag}`)
    //     if (hasNoGiftboxTag === false) {
    //       setGiftboxValid(true);
    //       setLoadingGiftCheck(false);
    //       return;
    //     }
    //   }
    // } catch (err) {
    //   console.error("Error fetching product tags for giftbox:", err);
    //   // If error, let's be safe and hide giftbox
    //   setGiftboxValid(true);
    //   setLoadingGiftCheck(false);
    //   return;
    // }

    // // 2) If domain = honey-birdette-usa & shipping to US, call external inventory check
    // if (myshopifyDomain === "honey-birdette-usa.myshopify.com" && shippingAddress?.countryCode === "US" && hasNoGiftboxProductTag === false) {
    //   console.log("Condition met: honeybirdette US shop and shipping to US");
    //   try {
    //     const items = lines.map((item) => ({
    //       sku: item.merchandise.sku,
    //       quantity: item.quantity,
    //     }));

    //     const deliveryValidatorEndpoint = "https://hb-stores-api-prod.herokuapp.com/check-inventory-v2";

    //     const reqBody = {
    //       countryCode: shippingAddress.countryCode,
    //       items,
    //     };

    //     const fetchResp = await fetch(deliveryValidatorEndpoint, {
    //       method: "POST",
    //       headers: { "Content-Type": "application/json; charset=utf-8" },
    //       body: JSON.stringify(reqBody),
    //     });

    //     const data = await fetchResp.json();
    //     const products = data.inventoryData;
    //     let allProductsValid = true;
    //     products.forEach((p) => {
    //       if (!p.isAvailable) {
    //         allProductsValid = false;
    //       }
    //     });

    //     setGiftboxValid(allProductsValid);
    //     setLoadingGiftCheck(false);
    //   } catch (error) {
    //     console.error("Giftbox inventory check error:", error);
    //     // If error, default to not showing giftbox
    //     setGiftboxValid(false);
    //     setLoadingGiftCheck(false);
    //   }
    // } else if (myshopifyDomain === "honey-birdette-usa.myshopify.com" && hasNoGiftboxProductTag === true) {
    //   setGiftboxValid(false);
    //   setLoadingGiftCheck(false);
    // } else if (myshopifyDomain === "honey-birdette-usa.myshopify.com" && hasNoGiftboxProductTag === false) {
    //   setGiftboxValid(false);
    //   setLoadingGiftCheck(false);
    // } else if (hasNoGiftboxProductTag === true) {
    //   setGiftboxValid(false);
    //   setLoadingGiftCheck(false);
    // } else {
    //   console.log("Condition not met: either not honeybirdette US or not shipping to US");
    //   setGiftboxValid(true);
    //   setLoadingGiftCheck(false);
    // }
  }

  checkGiftboxes();
}, [lines, myshopifyDomain, shippingAddress]);


  useEffect(() => {
    // Fetch all variants in parallel
    async function fetchAll() {
      setLoading(true);
      await Promise.all([
        fetchVariant(variantId1, 1),
        fetchVariant(variantId2, 2),
        fetchVariant(variantId3, 3),
        fetchVariant(variantId4, 4),
        fetchVariant(variantId5, 5),
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
    variantId5,
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
    const result = await shopify.applyCartLinesChange({
      type: "addCartLine",
      merchandiseId: String(variantId),
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
      const response = await shopify.query<{ node: any }>(
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
        case 5:
          setVariant5(fetchedVariant);
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
    variant5,
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
  variant5={variant5}

  giftboxValid={giftboxIsActive}
  cartLines={lines}

  // API/Handlers
  i18n={i18n}
  adding={adding}
  handleAddToCart={handleAddToCart}
  showError={showError}

  // Product 1
  titleSetting1={titleSetting1}
  descriptionSetting1={descriptionSetting1}
  isGWP1={isGWP1}
  isGiftbox1={isGiftbox1}

  // Product 2
  titleSetting2={titleSetting2}
  descriptionSetting2={descriptionSetting2}
  isGWP2={isGWP2}
  isGiftbox2={isGiftbox2}

  // Product 3
  titleSetting3={titleSetting3}
  descriptionSetting3={descriptionSetting3}
  isGWP3={isGWP3}
  isGiftbox3={isGiftbox3}

  // Product 4
  titleSetting4={titleSetting4}
  descriptionSetting4={descriptionSetting4}
  isGWP4={isGWP4}
  isGiftbox4={isGiftbox4}

  // Product 5
  titleSetting5={titleSetting5}
  descriptionSetting5={descriptionSetting5}
  isGWP5={isGWP5}
  isGiftbox5={isGiftbox5}

/>
  );
}

// Display a skeleton while we load variants
function LoadingSkeleton({ titleSetting, descriptionSetting }) {
  const translate = useTranslate();
  return (
    <s-query-container>
      <s-stack gap="small-200" background="subdued" borderWidth="large" padding="base">
        <s-grid
          gap="base"
          padding="small-200 none base none"
          gridTemplateColumns="1fr"
          alignItems="center"
        >
          <s-stack gap="none">
            <s-grid
              padding="none none small-200 none"
              gap="base"
              gridTemplateColumns="auto 1fr"
              alignItems="start"
            >
              <s-icon type="bag" />
              <s-heading>{titleSetting}</s-heading>
            </s-grid>
            <s-paragraph>
              <s-text>{descriptionSetting}</s-text> <s-text type="strong">...</s-text>
            </s-paragraph>
          </s-stack>
        </s-grid>

        <s-stack gap="large-200">
          <s-grid
            padding="none none small-200 none"
            gap="base"
            gridTemplateColumns={`@container (inline-size > ${WIDE_LAYOUT_MIN}) '20% 40%', '20% 80%'`}
            alignItems="center"
          >
            <s-box>
              <s-image aspectRatio="1" inlineSize="fill" />
            </s-box>

            <s-button variant="secondary" disabled accessibilityLabel="Add Items to cart" inlineSize="fill">
              {translate("add-to-cart")}
            </s-button>
          </s-grid>
        </s-stack>
      </s-stack>
    </s-query-container>
  );
}
function ProductOffer({
  // --- Variants ---
  variant1,
  variant2,
  variant3,
  variant4,
  variant5,

  giftboxValid,
  cartLines,

  // --- API / Handlers ---
  i18n,
  adding,
  handleAddToCart,
  showError,

  // --- Product 1 ---
  titleSetting1,
  descriptionSetting1,
  isGWP1,
  isGiftbox1,

  // --- Product 2 ---
  titleSetting2,
  descriptionSetting2,
  isGWP2,
  isGiftbox2,

  // --- Product 3 ---
  titleSetting3,
  descriptionSetting3,
  isGWP3,
  isGiftbox3,

  // --- Product 4 ---
  titleSetting4,
  descriptionSetting4,
  isGWP4,
  isGiftbox4,

  // --- Product 5 ---
  titleSetting5,
  descriptionSetting5,
  isGWP5,
  isGiftbox5,
}) {
  // Rendered with Polaris web components
  // (s-scroll-box, s-stack, s-grid, s-heading, etc.)

  // 1. Bundle each product’s data into an array
  const allItems = [
    {
      variant: variant1,
      title: titleSetting1,
      description: descriptionSetting1,
      isGWP: isGWP1,
      isGiftbox: isGiftbox1,
    },
    {
      variant: variant2,
      title: titleSetting2,
      description: descriptionSetting2,
      isGWP: isGWP2,
      isGiftbox: isGiftbox2,
    },
    {
      variant: variant3,
      title: titleSetting3,
      description: descriptionSetting3,
      isGWP: isGWP3,
      isGiftbox: isGiftbox3,
    },
    {
      variant: variant4,
      title: titleSetting4,
      description: descriptionSetting4,
      isGWP: isGWP4,
      isGiftbox: isGiftbox4,
    },
    {
      variant: variant5,
      title: titleSetting5,
      description: descriptionSetting5,
      isGWP: isGWP5,
      isGiftbox: isGiftbox5,
    }
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
    <s-query-container>
      <s-scroll-box
        maxBlockSize="300px"
        padding="base"
        border="base"
        borderRadius="base"
      >
        <s-box border="none" padding="none" minBlockSize="50px">
          {/* Product upsell section */}
          {filteredItems.length > 0 && (
            <s-stack gap="small-200">
              {filteredItems.map((item, index) => (
                <VariantCard
                  key={`product-${index}`}
                  variant={item.variant}
                  title={item.title}
                  description={item.description}
                  isGWP={item.isGWP}
                  isGiftbox={item.isGiftbox}
                  giftboxValid={giftboxValid}
                  i18n={i18n}
                  adding={adding}
                  handleAddToCart={handleAddToCart}
                />
              ))}
            </s-stack>
          )}

          {showError && <ErrorBanner />}
        </s-box>
      </s-scroll-box>
    </s-query-container>
  );
}

/**
 * Renders each variant’s card: image, title, description, and Add-to-cart button.
 * Incorporates GWP logic if desired (e.g., hide price or show 'FREE').
 */
function VariantCard({
  variant,
  title,
  description,
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
    ? `${imageUrl}?width=250`
    : "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png";

  return (
    <s-stack
      background="subdued"
      border="base"
      padding="base"
      gap="none"
    >
      <s-grid
        gap="base"
        gridTemplateColumns={`@container (inline-size > ${WIDE_LAYOUT_MIN}) 'auto 1fr auto', 'auto 1fr'`}
        alignItems="center"
      >
        {/* Image */}
        <s-box maxInlineSize="80px">
          <s-image
            src={finalImageUrl}
            alt={product.title || "Product image"}
            inlineSize="fill"
            border="none"
          />
        </s-box>

        {/* Text Info: Title / Desc / Price */}
        <s-stack gap="small-400">
          <s-grid
            gap="small-200"
            padding="none none none none"
            gridTemplateColumns="auto 1fr"
            alignItems="start"
          >
            {isGWP && <s-icon type="gift-card" />}
            <s-heading> {title}</s-heading>
          </s-grid>

          <s-paragraph>
            <s-text>{description}</s-text>
            {" "}
            <s-text type="strong">{priceWithSymbol}</s-text>
          </s-paragraph>

          <s-grid
            display={`@container (inline-size > ${WIDE_LAYOUT_MIN}) none, auto`}
            gap="base"
            gridTemplateColumns="1fr"
            alignItems="center"
          >
            <s-button
              variant={isGWP ? "secondary" : "secondary"}
              inlineSize="fill"
              loading={adding}
              onClick={() => handleAddToCart(variant.id)}
            >
              {isGWP ? translate('add-free-gift') : translate('add-to-cart')}
            </s-button>
          </s-grid>
        </s-stack>

        <s-grid
          display={`@container (inline-size > ${WIDE_LAYOUT_MIN}) auto, none`}
          gap="base"
          gridTemplateColumns="1fr"
          alignItems="center"
        >
          <s-button
            variant={isGWP ? "secondary" : "secondary"}
            inlineSize="fill"
            loading={adding}
            onClick={() => handleAddToCart(variant.id)}
          >
            {isGWP ? translate('add-free-gift') : translate('add-to-cart')}
          </s-button>
        </s-grid>
      </s-grid>
    </s-stack>
  );
}

function ErrorBanner() {
  return (
    <s-banner tone="critical">
      There was an issue adding this product. Please try again.
    </s-banner>
  );
}