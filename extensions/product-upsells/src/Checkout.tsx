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
} from "@shopify/ui-extensions-react/checkout";

// Set up the entry point for the extension
export default reactExtension("purchase.checkout.block.render", () => <App />);

function App() {
  const { query, i18n } = useApi();
  const applyCartLinesChange = useApplyCartLinesChange();

  // Store variants in state
  const [variant1, setVariant1] = useState(null);
  const [variant2, setVariant2] = useState(null);
  const [variant3, setVariant3] = useState(null);
  const [variant4, setVariant4] = useState(null);
  const [variant5, setVariant5] = useState(null);
  const [variant6, setVariant6] = useState(null);
  const [variant7, setVariant7] = useState(null);
  const [variant8, setVariant8] = useState(null);
  const [variant9, setVariant9] = useState(null);

  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showError, setShowError] = useState(false);

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
  
    // Product 6
    product6,
    product6_is_gwp,
    product6_is_giftbox,
    product6_title,
    product6_description,
  
    // Product 7
    product7,
    product7_is_gwp,
    product7_is_giftbox,
    product7_title,
    product7_description,
  
    // Product 8
    product8,
    product8_is_gwp,
    product8_is_giftbox,
    product8_title,
    product8_description,
  
    // Product 9
    product9,
    product9_is_gwp,
    product9_is_giftbox,
    product9_title,
    product9_description,

    giftbox_section_title,
    product_section_title,
    scroll_container_height,
  } = useSettings();

  // Provide fallback variant IDs if none are configured in settings
  const variantId1 = product1 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId2 = product2 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId3 = product3 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId4 = product4 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId5 = product5 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId6 = product6 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId7 = product7 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId8 = product8 ?? "gid://shopify/ProductVariant/41816694947955";
  const variantId9 = product9 ?? "gid://shopify/ProductVariant/41816694947955";

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

// Product 6
const titleSetting6 = product6_title ?? "Upsell Title";
const descriptionSetting6 = product6_description ?? "Upsell Description.";
const isGWP6 = product6_is_gwp ?? false;
const isGiftbox6 = product6_is_giftbox ?? false;

// Product 7
const titleSetting7 = product7_title ?? "Upsell Title";
const descriptionSetting7 = product7_description ?? "Upsell Description.";
const isGWP7 = product7_is_gwp ?? false;
const isGiftbox7 = product7_is_giftbox ?? false;

// Product 8
const titleSetting8 = product8_title ?? "Upsell Title";
const descriptionSetting8 = product8_description ?? "Upsell Description.";
const isGWP8 = product8_is_gwp ?? false;
const isGiftbox8 = product8_is_giftbox ?? false;

// Product 9
const titleSetting9 = product9_title ?? "Upsell Title";
const descriptionSetting9 = product9_description ?? "Upsell Description.";
const isGWP9 = product9_is_gwp ?? false;
const isGiftbox9 = product9_is_giftbox ?? false;


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
        fetchVariant(variantId6, 6),
        fetchVariant(variantId7, 7),
        fetchVariant(variantId8, 8),
        fetchVariant(variantId9, 9),
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
    variantId6,
    variantId7,
    variantId8,
    variantId9,
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
        case 5:
          setVariant5(fetchedVariant);
          break;
        case 6:
          setVariant6(fetchedVariant);
          break;
        case 7:
          setVariant7(fetchedVariant);
          break;
        case 8:
          setVariant8(fetchedVariant);
          break;
        case 9:
          setVariant9(fetchedVariant);
          break;
      }
    } catch (error) {
      console.error("Error fetching variant:", error);
    }
  }


  if (loading) {
    return <LoadingSkeleton titleSetting="..." descriptionSetting="..." />;
  }

  // If any of these variant IDs is in the cart already, hide the offer
  const isVariantInCart = lines.some((line) =>
    [
      variantId1,
      variantId2,
      variantId3,
      variantId4,
      variantId5,
      variantId6,
      variantId7,
      variantId8,
      variantId9,
    ].includes(line.merchandise.id)
  );

  // If we have not loaded any variant data at all, return null
  const variantsLoaded = [
    variant1,
    variant2,
    variant3,
    variant4,
    variant5,
    variant6,
    variant7,
    variant8,
    variant9,
  ].some(Boolean);

  if (!variantsLoaded) {
    return null;
  }

  // If all variants are in the cart, return null
  if (isVariantInCart) {
    return null;
  }

  // Pass the loaded variant objects into ProductOffer
  return (
<ProductOffer
  // Variants
  variant1={variant1}
  variant2={variant2}
  variant3={variant3}
  variant4={variant4}
  variant5={variant5}
  variant6={variant6}
  variant7={variant7}
  variant8={variant8}
  variant9={variant9}

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

  // Product 6
  titleSetting6={titleSetting6}
  descriptionSetting6={descriptionSetting6}
  isGWP6={isGWP6}
  isGiftbox6={isGiftbox6}

  // Product 7
  titleSetting7={titleSetting7}
  descriptionSetting7={descriptionSetting7}
  isGWP7={isGWP7}
  isGiftbox7={isGiftbox7}

  // Product 8
  titleSetting8={titleSetting8}
  descriptionSetting8={descriptionSetting8}
  isGWP8={isGWP8}
  isGiftbox8={isGiftbox8}

  // Product 9
  titleSetting9={titleSetting9}
  descriptionSetting9={descriptionSetting9}
  isGWP9={isGWP9}
  isGiftbox9={isGiftbox9}
/>
  );
}

// Display a skeleton while we load variants
function LoadingSkeleton({ titleSetting, descriptionSetting }) {
  const translate = useTranslate();
  return (
    <BlockStack spacing="tight" background="subdued" borderWidth="medium" padding="base">
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
            <Text>{descriptionSetting}</Text> <Text emphasis="bold">...</Text>
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
  variant5,
  variant6,
  variant7,
  variant8,
  variant9,

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

  // --- Product 6 ---
  titleSetting6,
  descriptionSetting6,
  isGWP6,
  isGiftbox6,

  // --- Product 7 ---
  titleSetting7,
  descriptionSetting7,
  isGWP7,
  isGiftbox7,

  // --- Product 8 ---
  titleSetting8,
  descriptionSetting8,
  isGWP8,
  isGiftbox8,

  // --- Product 9 ---
  titleSetting9,
  descriptionSetting9,
  isGWP9,
  isGiftbox9,
}) {
  // We import these from @shopify/ui-extensions-react/checkout
  // (ScrollView, BlockStack, InlineLayout, Heading, etc.)

  const translate = useTranslate();

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
    },
    {
      variant: variant6,
      title: titleSetting6,
      description: descriptionSetting6,
      isGWP: isGWP6,
      isGiftbox: isGiftbox6,
    },
    {
      variant: variant7,
      title: titleSetting7,
      description: descriptionSetting7,
      isGWP: isGWP7,
      isGiftbox: isGiftbox7,
    },
    {
      variant: variant8,
      title: titleSetting8,
      description: descriptionSetting8,
      isGWP: isGWP8,
      isGiftbox: isGiftbox8,
    },
    {
      variant: variant9,
      title: titleSetting9,
      description: descriptionSetting9,
      isGWP: isGWP9,
      isGiftbox: isGiftbox9,
    },
  ];

  // 2. Separate giftbox items vs. other items
  // const giftboxItems = allItems.filter((item) => item.isGiftbox && item.variant);
  // const productItems = allItems.filter((item) => !item.isGiftbox && item.variant);

  return (

    <ScrollView
      maxBlockSize={300}
      hint="innerShadow"
      padding="base"
      border="base"
      borderRadius="base"
    >
      <View   border="none"
        padding="none"
        minBlockSize={50}>


        {/* Product upsell section */}
        {allItems.length > 0 && (
          <BlockStack spacing="tight">
            
            {allItems.map((item, index) => (
              <VariantCard
                key={`product-${index}`}
                variant={item.variant}
                title={item.title}
                description={item.description}
                isGWP={item.isGWP}
                isGiftbox={item.isGiftbox}
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
  i18n,
  adding,
  handleAddToCart
}) {
  const product = variant?.product || {};
  const variantTitle = variant?.title || "";
  const priceAmount = variant?.price?.amount || "0.00";
  const imageUrl = product?.images?.nodes?.[0]?.url || "";
  const translate = useTranslate();

  // Format the price (If GWP is true, optionally skip or show 'FREE')
  let formattedPrice = i18n.formatCurrency(priceAmount).replace(/\.00$/, "");
  if (isGWP) {
    // For GWP, you might set formattedPrice = "FREE" or similar:
    formattedPrice = "FREE"; 
  }

  // Provide a fallback image if none is available
  const finalImageUrl = imageUrl
    ? `${imageUrl}?width=250`
    : "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png";

  return (
    <BlockStack 
      background="subdued"
      border="base"
      borderRadius="loose"
      padding="base"
      spacing="none"
    >
      <InlineLayout spacing="base" columns={["auto", "fill", "auto"]} blockAlignment="center">
        {/* Image */}
        <View maxInlineSize={80}>
          <Image
            source={finalImageUrl}
            alt={product.title || "Product image"}
            size="fill"
            border="none"
            borderRadius="loose"
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
             {isGWP && <Icon source="bag" />}
            <Heading level={2}> {title}</Heading>
          </InlineLayout>
      
          <TextBlock>
            <Text>{description}</Text> 
            {" "}
            <Text emphasis="bold">{formattedPrice}</Text>
          </TextBlock>

          <InlineLayout
          display={Style.default(['auto']).when({ viewportInlineSize: { min: 'small' } }, 'none')}
          spacing="base"
          columns={["fill"]}
          blockAlignment="center"
          >
            <Button
              kind={isGWP ? "primary" : "secondary" }
              loading={adding}
              onPress={() => handleAddToCart(variant.id)}
            >
              {isGWP ? translate('add-free-gift') : translate('add-to-cart') }
            </Button>
        </InlineLayout>
        </BlockStack>

        <InlineLayout
          display={Style.default(['none']).when({ viewportInlineSize: { min: 'small' } }, 'auto')}
          spacing="base"
          columns={["fill"]}
          blockAlignment="center"
          >
            <Button
              kind={isGWP ? "primary" : "secondary" }
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