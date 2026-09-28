import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useCartLines,
  useSettings,
  useTranslate,
  useShop,
  useShippingAddress, // Import the useShippingAddress hook
} from "@shopify/ui-extensions/checkout/preact";

// Container width (px) above which the wide layout is used. Replaces the legacy
// Style.when({ viewportInlineSize: { min: 'small' } }) viewport breakpoint.
const WIDE = "(inline-size > 450px)";

// Set up the entry point for the extension
export default function extension() {
  render(<App />, document.body);
}

function App() {
  const { query, i18n } = shopify;
  const { myshopifyDomain } = useShop(); // Get the shop domain
  const shippingAddress = useShippingAddress(); // Get the shipping address
  const [variant, setVariant] = useState(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showError, setShowError] = useState(false);
  const [productsValid, setProductsValid] = useState(true);
  const [productsHaveNoGiftTag, setProductsHaveNoGiftTag] = useState(false);

  const lines = useCartLines();
  const { product } = useSettings() as { product?: string };
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


    const productIds = lines.map(line => line.merchandise.product.id);
    const fetchProductTags = async () => {
          try {
            const response = await query<any>(
              `query ($productIds: [ID!]!) {
                  nodes(ids: $productIds) {
                      ... on Product {
                          id
                          title
                          tags
                      }
                  }
              }`,
              { variables: { productIds } } 
          );


            console.log("Fetched product data for giftbox:", response);

            // Check if any product has the "no-giftbox" tag
            const hasNoGiftboxTag = response.data.nodes.some(product => 
                product.tags?.includes("no-giftbox")
            );

            if (hasNoGiftboxTag) {
                console.log("Cart contains a product with 'no-giftbox' tag. Disabling giftbox offer.");
                setProductsValid(false);
                setProductsHaveNoGiftTag(false);
                return;
            }

        } catch (error) {
            console.error("Error fetching product tags:", error);
        }
    };  
    fetchProductTags();
    console.log("productsHaveNoGiftTag")
    console.log(productsHaveNoGiftTag)

    var validForGiftBox = false;

    if(myshopifyDomain === 'honey-birdette-usa.myshopify.com' && shippingAddress?.countryCode === 'US') {
      validForGiftBox = true;
    }

    if(myshopifyDomain === 'honey-birdette-2.myshopify.com' && shippingAddress?.countryCode === 'AU') {
      validForGiftBox = true;
    }

    if (validForGiftBox && productsHaveNoGiftTag === false) {
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

    } else if((myshopifyDomain === 'honey-birdette-usa.myshopify.com' || myshopifyDomain === 'honey-birdette-2.myshopify.com') && productsHaveNoGiftTag === false){
      setProductsValid(false); 

    } else if(productsHaveNoGiftTag === true){
      setProductsValid(false); 
    } else {
      console.log("Condition not met: either not honeybirdette US / AU or not shipping to US / AU");
      setProductsValid(true); // Allow if not US or not honeybirdette US
    }
  }, [myshopifyDomain, shippingAddress, lines]);


  async function handleAddToCart(variantId) {
    setAdding(true);
    const result = await shopify.applyCartLinesChange({
      type: "addCartLine",
      merchandiseId: variantId,
      quantity: 1,
      attributes: [
        { key: "_checkout_upsell", value: "true" }
      ],
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
      const response = await query<any>(
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

  console.log("productsValid")
  console.log(productsValid)

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
              <s-icon type="gift-card" />
              <s-heading>{translate('title')}</s-heading>
            </s-grid>
            <s-paragraph>
              <s-text>{translate('description')}</s-text> <s-text type="strong">...</s-text>
            </s-paragraph>
          </s-stack>
        </s-grid>

        <s-stack gap="large-200">
          <s-grid
            padding="none none small-200 none"
            gap="base"
            gridTemplateColumns={`@container ${WIDE} '20% 40%', '30% 70%'`}
            alignItems="center"
          >
            <s-box>
              <s-box background="base" borderRadius="base" minBlockSize="80px" />
            </s-box>

            <s-button
              variant="secondary"
              inlineSize="fill"
              disabled
              accessibilityLabel={`Add Giftbox to cart`}
            >
              {translate('add-to-cart')}
            </s-button>
          </s-grid>
        </s-stack>
      </s-stack>
    </s-query-container>
  );
}

function ProductOffer({ product, i18n, adding, handleAddToCart, showError }) {
  const { product: productData, price } = product;
  console.log(product);
  const appendWidth = (url) => `${url}&width=250`;
  const translate = useTranslate();
  const formattedPrice = i18n.formatCurrency(price.amount).replace(/\.00$/, '').replace(/\,00$/, '');
  const currencySymbols = {
      EUR: '€',
      USD: '$',
      AUD: 'A$',
      NZD: 'NZ$',
      GBP: '£',
      CAD: 'C$'
  };
  const priceWithSymbol = formattedPrice
    .replace(/\b(EUR|USD|AUD|NZD|GBP|CAD)\b/g, (match) => currencySymbols[match])
    .replace(/\s+/g, ''); 
  const imageUrl =
    productData.images.nodes[0]?.url
      ? appendWidth(productData.images.nodes[0].url)
      : appendWidth("https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081");

  // Narrow containers only (legacy: default 'auto', 'none' from the small viewport up)
  const narrowOnly = `@container ${WIDE} none, auto`;
  // Wide containers only (legacy: default 'none', 'auto' from the small viewport up)
  const wideOnly = `@container ${WIDE} auto, none`;

  return (
    <s-query-container>
      <s-stack gap="small-200" background="subdued" border="base" borderWidth="base" padding="base">
        <s-grid
          display={narrowOnly}
          gap="base"
          gridTemplateColumns="1fr"
          alignItems="center"
        >
          <s-stack gap="none">
            <s-grid
              gap="base"
              padding="none none small-200 none"
              gridTemplateColumns="auto 1fr"
              alignItems="start"
            >
              <s-icon type="gift-card" />
              <s-heading> {translate('title')}</s-heading>
            </s-grid>
            <s-grid display={wideOnly}>
              <s-paragraph>
                <s-text>{translate('description')}</s-text>{" "}
                <s-text type="strong">
                  {priceWithSymbol}
                </s-text>
              </s-paragraph>
            </s-grid>
          </s-stack>
        </s-grid>

        <s-stack gap="large-200">
          <s-grid
            padding="none none small-200 none"
            gap="base"
            gridTemplateColumns={`@container ${WIDE} '20% 1fr', '30% 70%'`}
            alignItems="center"
          >
            <s-box>
              <s-image
                inlineSize="fill"
                src={imageUrl}
                alt={productData.title}
              />
            </s-box>

            <s-box>
              <s-stack gap="base" display={wideOnly}>
                <s-grid
                  gap="base"
                  gridTemplateColumns="auto auto"
                  alignItems="start"
                >
                  <s-icon type="gift-card" />
                  <s-heading>{translate('title')}</s-heading>
                </s-grid>
                <s-paragraph>
                  <s-text>{translate('description')}</s-text>{" "}
                  <s-text type="strong">
                    {priceWithSymbol}
                  </s-text>
                </s-paragraph>

                <s-grid
                  gap="base"
                  gridTemplateColumns="100%"
                  alignItems="center"
                >
                  <s-box>
                    <s-button
                      variant="secondary"
                      inlineSize="fill"
                      loading={adding}
                      accessibilityLabel={`Add ${productData.title} to cart`}
                      onClick={() => handleAddToCart(product.id)}
                    >
                      {translate('add-to-cart')}
                    </s-button>
                  </s-box>
                </s-grid>
              </s-stack>

              <s-stack gap="base" display={narrowOnly}>
                <s-paragraph>
                  <s-text>{translate('description')}</s-text>{" "}
                  <s-text type="strong">
                    {priceWithSymbol}
                  </s-text>
                </s-paragraph>

                <s-grid
                  gap="base"
                  gridTemplateColumns="1fr"
                  alignItems="center"
                >
                  <s-button
                    variant="secondary"
                    inlineSize="fill"
                    loading={adding}
                    accessibilityLabel={`Add ${productData.title} to cart`}
                    onClick={() => handleAddToCart(product.id)}
                  >
                    {translate('add-to-cart')}
                  </s-button>
                </s-grid>
              </s-stack>
            </s-box>
          </s-grid>
        </s-stack>
        {showError && <ErrorBanner />}
      </s-stack>
    </s-query-container>
  );
}

function ErrorBanner() {
  return (
    <s-banner tone="critical">
      There was an issue adding this product. Please try again.
    </s-banner>
  );
}
