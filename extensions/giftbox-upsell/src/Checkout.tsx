import React, { useEffect, useState } from "react";
import {
  reactExtension,
  Divider,
  ProductThumbnail,
  Banner,
  Heading,
  Button,
  InlineLayout,
  BlockStack,
  Text,
  Image,
  View,
  TextBlock,
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
  useShippingAddress, // Import the useShippingAddress hook
} from "@shopify/ui-extensions-react/checkout";

// Set up the entry point for the extension
export default reactExtension("purchase.checkout.block.render", () => <App />);

function App() {
  const { query, i18n } = useApi();
  const applyCartLinesChange = useApplyCartLinesChange();
  const { myshopifyDomain } = useShop(); // Get the shop domain
  const shippingAddress = useShippingAddress(); // Get the shipping address
  const [variant, setVariant] = useState(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showError, setShowError] = useState(false);
  const [productsValid, setProductsValid] = useState(true);

  const lines = useCartLines();
  const { product } = useSettings();
  const variantId = product ?? "gid://shopify/ProductVariant/41816694947955";

  useEffect(() => {
    if (variantId) {
      fetchVariant(variantId);
    }
  }, [variantId]);

  useEffect(() => {
    if (showError) {
      const timer = setTimeout(() => setShowError(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showError]);

  useEffect(() => {
    console.log("myshopifyDomain:", myshopifyDomain);
    console.log("shippingAddress:", shippingAddress);
    console.log("lines:", lines);
  
    if (myshopifyDomain === 'honey-birdette-us.myshopify.com' && shippingAddress?.countryCode === 'US') {
      console.log("Condition met: honeybirdette US shop and shipping to US");
  
      const items = lines.map(item => ({
        sku: item.merchandise.sku,
        quantity: item.quantity,
      }));
      
      console.log("Mapped items:", items);
  
      const request = {
        countryCode: shippingAddress.countryCode,
        items: items,
      };
  
      console.log("Request payload:", request);
  
      const deliveryValidatorEndpoint = "https://hb-stores-api-prod.herokuapp.com/check-inventory-v2";
  
      fetch(deliveryValidatorEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(request),
      })
        .then(response => response.json())
        .then(data => {
          console.log("API Response data:", data);
          const products = data.inventoryData;
          let allProductsValid = true;
  
          products.forEach((product) => {
            if (!product.isAvailable) {
              console.log(`Product unavailable:`, product);
              allProductsValid = false;
              return false;
            }
          });
  
          if (allProductsValid) {
            console.log("All products are valid");
            setProductsValid(true);
          } else {
            console.log("Some products are not valid");
            setProductsValid(false);
          }
        })
        .catch(error => {
          console.error("RESPONSE - Error:", error);
          setProductsValid(false);
        });
    } else {
      console.log("Condition not met: either not honeybirdette US or not shipping to US");
      setProductsValid(true); // Allow if not US or not honeybirdette US
    }
  }, [myshopifyDomain, shippingAddress, lines]);
  

  async function handleAddToCart(variantId) {
    setAdding(true);
    const result = await applyCartLinesChange({
      type: "addCartLine",
      merchandiseId: variantId,
      quantity: 1,
    });
    setAdding(false);
    if (result.type === "error") {
      setShowError(true);
      console.error(result.message);
    }
  }

  async function fetchVariant(variantId) {
    setLoading(true);

    try {
      const response = await query(
        `query ($variantId: ID!) {
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
        }`,
        {
          variables: { variantId },
        }
      );
      console.log("Fetch variant response:", response); // Debugging statement to check response
      if (response && response.data) {
        setVariant(response.data.node);
      } else {
        console.error('No variant response found:', response.errors || 'Unknown error');
      }
      
    } catch (error) {
      console.error('Error fetching variant:', error);
    } finally {
      setLoading(false);
    }
  }

  // Check if variantId is already in the cart
  const isVariantInCart = lines.some(line => line.merchandise.id === variantId);

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (!loading && !variant) {
    return null;
  }

  // Return null if the variant is already in the cart or products are not valid
  if (isVariantInCart || !productsValid) {
    return null;
  }

  const productOnOffer = variant ? [variant] : [];

  if (!productOnOffer.length) {
    return null;
  }

  return (
    <ProductOffer
      product={productOnOffer[0]}
      i18n={i18n}
      adding={adding}
      handleAddToCart={handleAddToCart}
      showError={showError}
    />
  );
}

function LoadingSkeleton() {
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
            <Icon source="gift" />
            <Heading level={2}>{translate('title')}</Heading>
          </InlineLayout>
          <TextBlock>
            <Text>{translate('description')}</Text> <Text emphasis="bold">...</Text>
          </TextBlock>
        </BlockStack>
      </InlineLayout>

      <BlockStack spacing="loose">
        <InlineLayout
          padding={["none", "none", "tight", "none"]}
          spacing="base"
          columns={Style.default(['30%', '70%']).when({ viewportInlineSize: { min: 'small' } }, ['20%', '40%'])}
          blockAlignment="center"
        >
          <View>
            <SkeletonImage aspectRatio={1} size="fill" />
          </View>

          <Button
            kind="secondary"
            disabled
            accessibilityLabel={`Add Giftbox to cart`}
          >
            {translate('add-to-cart')}
          </Button>
        </InlineLayout>
      </BlockStack>
    </BlockStack>
  );
}

function ProductOffer({ product, i18n, adding, handleAddToCart, showError }) {
  const { product: productData, price } = product;
  console.log(product);
  const appendWidth = (url) => `${url}&width=250`;
  const translate = useTranslate();
  const imageUrl =
    productData.images.nodes[0]?.url
      ? appendWidth(productData.images.nodes[0].url)
      : appendWidth("https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081");

  return (
    <BlockStack spacing="tight" background="subdued"  border="base" borderWidth="base" padding="base">
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
            <Icon source="gift" />
            <Heading level={2}>{translate('title')}</Heading>
          </InlineLayout>
          <TextBlock>
            <Text>{translate('description')}</Text>{" "}
            <Text emphasis="bold">
              {i18n.formatCurrency(price.amount).replace(/\.00$/, '').replace(/\,00$/, '')}
            </Text>
          </TextBlock>
        </BlockStack>
      </InlineLayout>

      <BlockStack spacing="loose">
        <InlineLayout
          padding={["none", "none", "tight", "none"]}
          spacing="base"
          columns={Style.default(['30%', '70%']).when({ viewportInlineSize: { min: 'small' } }, ['20%', '40%'])}
          blockAlignment="center"
        >
          <View>
            <Image
              size="fill"
              background="base"
              border="none"
              borderRadius="loose"
              source={imageUrl}
              alt={productData.title}
            />
          </View>

          <Button
            kind="secondary"
            loading={adding}
            accessibilityLabel={`Add ${productData.title} to cart`}
            onPress={() => handleAddToCart(product.id)}
          >
            {translate('add-to-cart')}
          </Button>
        </InlineLayout>
      </BlockStack>
      {showError && <ErrorBanner />}
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
