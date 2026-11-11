// @ts-nocheck -- plain-JS extension, shares helpers with Checkout.jsx.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import {
  RecommendationCard,
  fetchAppConfig,
  getShippingInfo,
  pickActiveMotivator,
  renderMotivatorText,
  resolveRecommendations,
  resolveShippingThresholds,
} from './Checkout.jsx';

// Renders inside the SELECTED shipping rate (target
// `purchase.checkout.shipping-option-item.details.render`): a "Don't pay for
// shipping" heading, a progress bar toward the next free-shipping goal, and a
// short list of products to close the gap. Uses the same app config
// (thresholds, motivators, manual upsells) as the main recommendations block.

const DEFAULT_HEADING = "Don't pay for shipping";
const DEFAULT_MAX_SLOTS = 2;

export default async () => {
  render(<ShippingRateUpsell />, document.body);
};

function ShippingRateUpsell() {
  const isSelected = shopify.isTargetSelected?.value;
  const option = shopify.target?.value;
  const isOverlay = Boolean(shopify.renderMode?.overlay);

  const isDraftOrder = shopify.checkoutSettings?.value?.orderSubmission === 'DRAFT_ORDER';
  const orderAttributes = shopify.attributes?.value ?? [];
  const isHoneyListCheckout = orderAttributes.some(
    (a) => a.key === 'honey_list' || (typeof a.key === 'string' && a.key.startsWith('hl_')),
  );

  const lines = shopify.lines.value;
  const countryCode = shopify.localization?.country?.value?.isoCode;
  const subtotal = shopify.cost?.subtotalAmount?.value;
  const currencyCode = subtotal?.currencyCode;
  const subtotalAmount = Number(subtotal?.amount);

  // Already free (e.g. a shipping discount applied): nothing to nudge toward.
  const rateCost = Number(option?.costAfterDiscounts?.amount ?? option?.cost?.amount);
  const rateIsFree = Number.isFinite(rateCost) && rateCost <= 0;

  const [appConfig, setAppConfig] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchAppConfig().then((cfg) => {
      if (!cancelled) setAppConfig(cfg || {});
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Goal: the active price-range motivator wins, else the next free-shipping tier.
  const activeMotivator = pickActiveMotivator(appConfig?.motivators, currencyCode, subtotalAmount);
  const fallback = getShippingInfo(resolveShippingThresholds(appConfig, currencyCode), subtotal);

  const gap = activeMotivator ? activeMotivator.remaining : fallback.gap;
  const goal = subtotalAmount + gap;
  const message = activeMotivator
    ? renderMotivatorText(activeMotivator.motivator.text, activeMotivator.remaining)
    : fallback.subtitle;

  const heading = appConfig?.shipping_rate_heading || DEFAULT_HEADING;
  const slotLimit = Number(appConfig?.shipping_rate_max_products) || DEFAULT_MAX_SLOTS;
  const manualProductIds = (appConfig?.manual_upsells || []).filter(Boolean);
  const motivatorProductIds = activeMotivator ? activeMotivator.motivator.products || [] : [];

  const shouldRender =
    isSelected &&
    !isOverlay &&
    !rateIsFree &&
    !isDraftOrder &&
    !isHoneyListCheckout &&
    appConfig != null &&
    gap > 0;

  const [cards, setCards] = useState([]);
  const [adding, setAdding] = useState(null);
  const [showError, setShowError] = useState(false);

  const cartKey = useMemo(
    () => lines.map((l) => `${l.merchandise?.id}:${l.quantity}`).join('|'),
    [lines],
  );
  const manualKey = manualProductIds.join('|');
  const motivatorKey = motivatorProductIds.join('|');

  useEffect(() => {
    if (!shouldRender) return undefined;

    let cancelled = false;

    resolveRecommendations({
      metaType: appConfig?.metaobject_type || 'mini_cart_recommendations',
      countryCode,
      slotLimit,
      lines,
      manualProductIds,
      motivatorProductIds,
    })
      // Motivator products bypass the slot cap in the resolver; trim here so the
      // rate stays compact.
      .then((result) => {
        if (!cancelled) setCards(result.slice(0, slotLimit));
      })
      .catch((err) => {
        console.error('[shipping-rate-upsell] resolve failed', err);
        if (!cancelled) setCards([]);
      });

    return () => {
      cancelled = true;
    };
  }, [shouldRender, cartKey, countryCode, slotLimit, manualKey, motivatorKey]);

  useEffect(() => {
    if (!showError) return undefined;
    const timer = setTimeout(() => setShowError(false), 3000);
    return () => clearTimeout(timer);
  }, [showError]);

  const handleAdd = async (variant) => {
    setAdding(variant.id);

    const result = await shopify.applyCartLinesChange({
      type: 'addCartLine',
      merchandiseId: variant.id,
      quantity: 1,
      attributes: [
        { key: '_checkout_upsell', value: 'true' },
        { key: '_addSource', value: 'Checkout:ShippingRate' },
      ],
    });

    setAdding(null);

    if (result.type === 'error') {
      setShowError(true);
      console.error(result.message);
    }
  };

  if (!shouldRender) return null;

  return (
    <s-stack gap="base">
      <s-stack gap="small-300">
        <s-text type="strong">{heading}</s-text>
        <s-progress
          value={Math.min(subtotalAmount, goal)}
          max={goal}
          accessibilityLabel="Progress toward free shipping"
        />
        {message && <s-text>{message}</s-text>}
      </s-stack>

      {cards.length > 0 && (
        <s-stack gap="base">
          {cards.map((card) => (
            <RecommendationCard
              key={card.productId}
              card={card}
              addingVariantId={adding}
              onAdd={handleAdd}
            />
          ))}
        </s-stack>
      )}

      {showError && (
        <s-banner tone="critical">
          There was an issue adding this product. Please try again.
        </s-banner>
      )}
    </s-stack>
  );
}
