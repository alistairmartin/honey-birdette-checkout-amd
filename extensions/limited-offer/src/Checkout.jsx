import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

// Shop metafield (app-owned) that both this UI and the discount function read.
// It is written by the admin app route when a promo week is activated.
const CONFIG_NAMESPACE = '$app';
const CONFIG_KEY = 'limited_offer_config';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const config = useConfig();

  // No active promo, or it's switched off: render nothing.
  if (!config || config.enabled === false) {
    return null;
  }

  const subtotalMoney = shopify.cost.subtotalAmount.value;
  const currencyCode = subtotalMoney?.currencyCode;
  const threshold = currencyCode ? config.thresholds?.[currencyCode] : undefined;

  // The promo is per-currency. If we don't have a threshold for the buyer's
  // currency, this market isn't part of the promo, so show nothing.
  if (typeof threshold !== 'number' || threshold <= 0) {
    return null;
  }

  const variantId = config.product?.variantId;
  if (!variantId) {
    return null;
  }

  return (
    <Offer
      config={config}
      variantId={variantId}
      threshold={threshold}
      subtotal={Number(subtotalMoney.amount) || 0}
    />
  );
}

function Offer({config, variantId, threshold, subtotal}) {
  const {i18n} = shopify;
  const percentage = config.discountPercentage ?? 50;
  const variant = useVariant(variantId);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(false);

  // Auto-dismiss the error banner.
  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => setError(false), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  if (!variant) {
    return null;
  }

  const toyTitle = variant.product?.title ?? config.product?.title ?? 'your toy';
  const remaining = Math.max(threshold - subtotal, 0);
  const unlocked = remaining <= 0;

  const fullPrice = Number(variant.price?.amount) || 0;
  const discountedPrice = fullPrice * (1 - percentage / 100);
  const imageUrl = variant.product?.images?.nodes?.[0]?.url;

  const lines = shopify.lines.value ?? [];
  const inCart = lines.some((line) => line.merchandise?.id === variantId);

  return (
    <s-stack
      gap="base"
      padding="base"
      borderRadius="large"
      background="subdued"
      border="base"
    >
      <s-stack direction="inline">
        <s-badge tone="neutral">{i18n.translate('badge')}</s-badge>
      </s-stack>

      <s-stack gap="small-200">
        <s-heading>
          {i18n.translate('unlock', {pct: percentage, toy: toyTitle})}
        </s-heading>
        <s-text color="subdued">
          {i18n.translate('claim', {amount: i18n.formatCurrency(threshold)})}
        </s-text>
      </s-stack>

      <s-stack gap="small-100">
        <s-progress
          value={Math.min(subtotal, threshold)}
          max={threshold}
          accessibilityLabel={i18n.translate('progressLabel', {
            amount: i18n.formatCurrency(subtotal),
            threshold: i18n.formatCurrency(threshold),
          })}
        />
        <s-grid gridTemplateColumns="auto auto" justifyContent="space-between">
          <s-text type="strong">{i18n.formatCurrency(subtotal)}</s-text>
          <s-text color="subdued">
            {i18n.translate('toUnlock', {amount: i18n.formatCurrency(threshold)})}
          </s-text>
        </s-grid>
      </s-stack>

      <s-text>
        {unlocked
          ? i18n.translate('unlocked', {pct: percentage, toy: toyTitle})
          : i18n.translate('spendMore', {
              amount: i18n.formatCurrency(remaining),
              pct: percentage,
              toy: toyTitle,
            })}
      </s-text>

      <s-grid
        gridTemplateColumns="64px 1fr auto"
        gap="base"
        alignItems="center"
        padding="base"
        borderRadius="base"
        border="base"
        background="base"
      >
        {imageUrl ? (
          <s-image
            src={`${imageUrl}${imageUrl.includes('?') ? '&' : '?'}width=160`}
            alt={toyTitle}
            inlineSize="fill"
            aspectRatio="1"
            borderRadius="base"
          />
        ) : (
          <s-box inlineSize="64px" blockSize="64px" borderRadius="base" background="subdued" />
        )}

        <s-stack gap="small-200">
          <s-text type="strong">{toyTitle}</s-text>
          <s-stack direction="inline" gap="small-100" alignItems="center">
            <s-text type="redundant" color="subdued">
              {i18n.formatCurrency(fullPrice)}
            </s-text>
            <s-text type="strong">{i18n.formatCurrency(discountedPrice)}</s-text>
            <s-badge tone="critical">
              {i18n.translate('off', {pct: percentage})}
            </s-badge>
          </s-stack>
        </s-stack>

        <s-button
          variant="secondary"
          loading={adding}
          disabled={inCart}
          accessibilityLabel={i18n.translate('addLabel', {toy: toyTitle})}
          onClick={onAdd}
        >
          {inCart ? i18n.translate('added') : i18n.translate('add')}
        </s-button>
      </s-grid>

      {error ? (
        <s-banner tone="critical">{i18n.translate('errorAdding')}</s-banner>
      ) : null}
    </s-stack>
  );

  async function onAdd() {
    setAdding(true);
    try {
      const result = await shopify.applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: variantId,
        quantity: 1,
        attributes: [{key: '_limited_offer', value: 'true'}],
      });
      if (result?.type === 'error') {
        setError(true);
        console.error('addCartLine failed', result.message);
      }
    } catch (err) {
      setError(true);
      console.error('addCartLine threw', err);
    } finally {
      setAdding(false);
    }
  }
}

// Reads the active promo config from the app-owned shop metafield.
function useConfig() {
  const entry = shopify.appMetafields.value.find(
    (m) =>
      m.target?.type === 'shop' &&
      m.metafield?.namespace === CONFIG_NAMESPACE &&
      m.metafield?.key === CONFIG_KEY,
  );
  if (!entry?.metafield?.value) {
    return null;
  }
  try {
    return JSON.parse(entry.metafield.value);
  } catch (err) {
    console.error('limited-offer: bad config metafield', err);
    return null;
  }
}

// Fetches the promo variant's price + image from the Storefront API.
function useVariant(variantId) {
  const [variant, setVariant] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!variantId) {
      setVariant(null);
      return undefined;
    }
    (async () => {
      try {
        const response = await shopify.query(
          `query Variant($id: ID!) {
            node(id: $id) {
              ... on ProductVariant {
                id
                price { amount currencyCode }
                product {
                  title
                  images(first: 1) { nodes { url } }
                }
              }
            }
          }`,
          {variables: {id: variantId}},
        );
        if (!cancelled) {
          setVariant(response?.data?.node ?? null);
        }
      } catch (err) {
        console.error('limited-offer: variant query failed', err);
        if (!cancelled) setVariant(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variantId]);

  return variant;
}
