import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {
  useCartLines,
  useSettings,
  useTranslate,
} from '@shopify/ui-extensions/checkout/preact';

// Set up the entry point for the extension
export default function extension() {
  render(<App />, document.body);
}

// The legacy Style helper switched layouts on the viewport ("small" breakpoint).
// Polaris web components only support container queries, so the switch is now
// based on the width of the extension's own container. Phones render the block
// at roughly 400px or less, tablet and desktop checkouts render it wider.
const DISPLAY_NARROW_ONLY = '@container (inline-size > 420px) none, auto';
const DISPLAY_WIDE_ONLY = '@container (inline-size > 420px) auto, none';

function App() {
  const i18n = shopify.i18n;
  const [variant, setVariant] = useState(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showError, setShowError] = useState(false);

  const lines = useCartLines();
  const { product, title, description, gwp } = useSettings();
  const variantId = (product ?? "gid://shopify/ProductVariant/41816694947955") as string;

  const titleSetting = title ?? 'Upsell Title';
  const descriptionSetting = description ?? 'Upsell Description.';
  const gwpSetting = gwp ?? false;

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
      const response = await shopify.query<{ node: any }>(
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

  // Return null if the variant is already in the cart
  if (isVariantInCart) {
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
      titleSetting={titleSetting}
      descriptionSetting={descriptionSetting}
      gwpSetting={gwpSetting}
    />
  );
}

function LoadingSkeleton({titleSetting, descriptionSetting}: {titleSetting?: any, descriptionSetting?: any}) {
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
            gridTemplateColumns="@container (inline-size > 420px) '20% 40%', '20% 1fr'"
            alignItems="center"
          >
            <s-box>
              <s-image aspectRatio="1" inlineSize="fill" />
            </s-box>

            <s-button
              variant="secondary"
              inlineSize="fill"
              disabled
              accessibilityLabel={`Add Items to cart`}
            >
              {translate('add-to-cart')}
            </s-button>
          </s-grid>
        </s-stack>
      </s-stack>
    </s-query-container>
  );
}

function ProductOffer({ product, i18n, adding, handleAddToCart, showError, titleSetting, descriptionSetting, gwpSetting }) {
  const { product: productData, price } = product;
  console.log(product)
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

  return (
    <s-query-container>
      <s-stack gap="small-200" background="subdued" border="base" borderWidth="base" padding="base">
        <s-grid
          display={DISPLAY_NARROW_ONLY}
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
              {gwpSetting && <s-icon type="bag" />}
              <s-heading> {titleSetting}</s-heading>
            </s-grid>
            <s-grid display={DISPLAY_WIDE_ONLY}>
              <s-paragraph>
                <s-text>{descriptionSetting}</s-text>{" "}
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
            gridTemplateColumns="20% 1fr"
            alignItems="center"
          >
            <s-box>
              <s-image
                inlineSize="fill"
                border="none"
                src={imageUrl}
                alt={productData.title}
              />
            </s-box>

            <s-box>
              <s-stack
                gap="base"
                display={DISPLAY_WIDE_ONLY}
              >
                <s-grid
                  gap="base"
                  gridTemplateColumns="auto auto"
                  alignItems="start"
                >
                  {gwpSetting && <s-icon type="gift-card" />}
                  <s-heading>{titleSetting}</s-heading>
                </s-grid>
                <s-paragraph>
                  <s-text>{descriptionSetting}</s-text>{" "}
                  <s-text type="strong">
                    {gwpSetting ? "FREE" : priceWithSymbol }
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
                      {gwpSetting ? translate('add-free-gift') : translate('add-to-cart') }
                    </s-button>
                  </s-box>
                </s-grid>
              </s-stack>

              <s-stack gap="base" display={DISPLAY_NARROW_ONLY}>
                <s-paragraph>
                  <s-text>{descriptionSetting}</s-text>{" "}
                  <s-text type="strong">
                    {gwpSetting ? "FREE" : priceWithSymbol }
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
                    {gwpSetting ? translate('add-free-gift') : translate('add-to-cart') }
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
