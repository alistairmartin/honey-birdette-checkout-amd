// @ts-nocheck -- plain-JS extension resolving dynamic Storefront GraphQL shapes.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

// Mirrors the theme's mini-cart recommendations (see honey-birdette-plby
// `src/components/libs/cart-recommendations.js`): resolve `mini_cart_recommendations`
// metaobjects against the cart first, then fall back to Shopify's product
// recommendations API so the carousel is never empty.
const DEFAULT_META_TYPE = 'mini_cart_recommendations';
const DEFAULT_MAX_SLOTS = 6;

export default async () => {
  render(<Extension />, document.body);
};

// ---------------------------------------------------------------------------
// Helpers (ported from the theme lib)
// ---------------------------------------------------------------------------

const parseBool = (value) => String(value ?? '').toLowerCase() === 'true';

const parseStringList = (raw) => {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed.map((s) => String(s).trim()).filter(Boolean);
    }
  } catch {
    // Fall through to CSV parse below.
  }

  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

const isWithinTimeWindow = (from, till) => {
  const now = Date.now();
  const start = from ? Date.parse(from) : null;
  const end = till ? Date.parse(till) : null;

  if (start && !Number.isNaN(start) && now < start) return false;
  if (end && !Number.isNaN(end) && now > end) return false;

  return true;
};

// Cart products, lingerie sets, and gift cards are never offered (they need a
// size/variant choice that the checkout carousel can't capture).
const isQuickAddIneligibleType = (productType) => {
  const type = String(productType || '').toLowerCase().trim();

  return type === 'lingerie set' || type.includes('gift card');
};

const currencySymbols = {
  EUR: '€',
  USD: '$',
  AUD: 'A$',
  NZD: 'NZ$',
  GBP: '£',
  CAD: 'C$',
};

const stripCurrency = (s) =>
  s
    .replace(/\b(EUR|USD|AUD|NZD|GBP|CAD)\b/g, (match) => currencySymbols[match])
    .replace(/\s+/g, '');

const formatPrice = (amount) =>
  stripCurrency(shopify.i18n.formatCurrency(Number(amount)).replace(/\.00$/, ''));

// Free-shipping progress tiers. Merchants set a standard and an express
// threshold per currency (keys like `free_standard_aud` / `free_express_aud`);
// the subtitle nudges the buyer toward whichever tier they haven't reached yet.
const SHIPPING_TIERS = [
  { suffix: 'standard', message: 'free shipping' },
  { suffix: 'express', message: 'free Express shipping' },
];

// Resolve the standard/express free-shipping thresholds for a currency from the
// app config (Checkout Recommendations admin page).
const resolveShippingThresholds = (appConfig, currencyCode) => {
  const upper = String(currencyCode || '').toUpperCase();
  const fromConfig = appConfig?.free_shipping?.[upper] || {};

  const pick = (suffix) => {
    const cfgVal = Number(fromConfig[suffix]);
    return Number.isFinite(cfgVal) && cfgVal > 0 ? cfgVal : 0;
  };

  return { standard: pick('standard'), express: pick('express') };
};

// Returns the shipping nudge subtitle plus the remaining spend ("gap") to the
// next free-shipping tier. The gap drives both the subtitle and the rule-1
// gap-fill recommendations.
const getShippingInfo = (thresholds, subtotal) => {
  if (!subtotal) return { subtitle: null, gap: 0 };

  const tiers = SHIPPING_TIERS.map((tier) => ({
    threshold: thresholds[tier.suffix],
    message: tier.message,
  }))
    .filter((tier) => Number.isFinite(tier.threshold) && tier.threshold > 0)
    .sort((a, b) => a.threshold - b.threshold);

  if (!tiers.length) return { subtitle: null, gap: 0 };

  // First tier the buyer hasn't cleared yet.
  const nextTier = tiers.find((tier) => subtotal.amount < tier.threshold);

  if (!nextTier) {
    return { subtitle: "You've got free shipping honey!", gap: 0 };
  }

  const gap = nextTier.threshold - subtotal.amount;

  return {
    subtitle: `Spend ${formatPrice(gap)} more to get ${nextTier.message}`,
    gap,
  };
};

// Price Range Motivators (the live rule). A motivator is active when the cart
// subtotal in its currency sits inside [min, max); the buyer is nudged toward
// `max` (e.g. a free-shipping threshold). When several overlap, the closest goal
// wins so the most attainable nudge shows.
const pickActiveMotivator = (motivators, currencyCode, subtotalAmount) => {
  if (!Array.isArray(motivators) || !currencyCode || !(subtotalAmount >= 0)) return null;

  let best = null;

  for (const m of motivators) {
    if (!m || m.enabled === false) continue;
    if (m.currency !== currencyCode) continue;

    const max = Number(m.max);
    if (!Number.isFinite(max) || max <= 0) continue;

    const min = Number(m.min) || 0;
    if (subtotalAmount < min || subtotalAmount >= max) continue;

    const remaining = max - subtotalAmount;
    if (!best || remaining < best.remaining) best = { motivator: m, remaining };
  }

  return best;
};

const renderMotivatorText = (text, remaining) =>
  String(text || '').replace(/\{\{\s*remaining\s*\}\}/g, formatPrice(remaining));

// Debug helper: for each configured motivator, explain whether it matched the
// current cart and, if not, why. Powers the "Show Testing Information" panel.
const describeMotivators = (motivators, currencyCode, subtotalAmount) => {
  if (!Array.isArray(motivators) || !motivators.length) return ['(no motivators in config)'];

  return motivators.map((m, i) => {
    const label = `#${i + 1} ${m?.currency || '?'} [${m?.min ?? 0}-${m?.max ?? '?'}]`;
    const reasons = [];

    if (!m) return `${label} | skip: empty`;
    if (m.enabled === false) reasons.push('disabled');
    if (m.currency !== currencyCode) reasons.push(`currency != ${currencyCode || '(none)'}`);

    const max = Number(m.max);
    const min = Number(m.min) || 0;

    if (!Number.isFinite(max) || max <= 0) reasons.push('invalid max');
    if (subtotalAmount < min) reasons.push(`subtotal < ${min}`);
    if (Number.isFinite(max) && subtotalAmount >= max) reasons.push(`subtotal >= ${max}`);

    return `${label} | ${reasons.length ? `skip: ${reasons.join(', ')}` : 'MATCH'}`;
  });
};

// ---------------------------------------------------------------------------
// GraphQL (Storefront API via `shopify.query`)
// ---------------------------------------------------------------------------

// Product fields needed to render a card + let the buyer choose a variant (size).
// We pull every variant so a multi-variant product opens a size picker instead of
// silently adding the first variant.
const PRODUCT_CARD_FIELDS = `
  id
  title
  handle
  productType
  tags
  featuredImage { url altText }
  variants(first: 50) {
    nodes {
      id
      title
      availableForSale
      selectedOptions { name value }
      price { amount currencyCode }
      compareAtPrice { amount currencyCode }
    }
  }
`;

const inContext = (countryCode) =>
  countryCode ? `@inContext(country: ${countryCode})` : '';

const fetchMetaobjects = async (type, countryCode) => {
  const query = `
    query CartRecommendationRules ${inContext(countryCode)} {
      metaobjects(type: "${type}", first: 50) {
        nodes {
          id
          handle
          fields {
            key
            value
            references(first: 50) {
              nodes {
                ... on Product { ${PRODUCT_CARD_FIELDS} }
              }
            }
          }
        }
      }
    }
  `;

  const { data, errors } = await shopify.query(query);

  if (errors?.length) {
    console.error('[checkout-recommendations] metaobject errors', errors);
  }

  return data?.metaobjects?.nodes || [];
};

const fetchCartProductDetails = async (productIds, countryCode) => {
  if (!productIds.length) return {};

  const query = `
    query CartProducts($ids: [ID!]!) ${inContext(countryCode)} {
      nodes(ids: $ids) {
        ... on Product { id handle productType tags }
      }
    }
  `;

  const { data, errors } = await shopify.query(query, { variables: { ids: productIds } });

  if (errors?.length) {
    console.error('[checkout-recommendations] cart product errors', errors);
  }

  const byId = {};

  (data?.nodes || []).filter(Boolean).forEach((p) => {
    byId[p.id] = p;
  });

  return byId;
};

// Manual upsells and motivator products are stored as product references. We
// fetch the full products (all variants) so the card can offer a size picker,
// and preserve the merchant's configured order.
const fetchProductsByIds = async (productIds, countryCode) => {
  if (!productIds.length) return [];

  const query = `
    query RecProducts($ids: [ID!]!) ${inContext(countryCode)} {
      nodes(ids: $ids) {
        ... on Product { ${PRODUCT_CARD_FIELDS} }
      }
    }
  `;

  const { data, errors } = await shopify.query(query, { variables: { ids: productIds } });

  if (errors?.length) {
    console.error('[checkout-recommendations] product fetch errors', errors);
  }

  const byId = {};

  (data?.nodes || []).filter(Boolean).forEach((p) => {
    byId[p.id] = p;
  });

  return productIds.map((id) => byId[id]).filter(Boolean);
};

const fetchProductRecommendations = async (productId, countryCode) => {
  const query = `
    query ProductRecs($productId: ID!) ${inContext(countryCode)} {
      productRecommendations(productId: $productId, intent: RELATED) {
        ${PRODUCT_CARD_FIELDS}
      }
    }
  `;

  const { data, errors } = await shopify.query(query, { variables: { productId } });

  if (errors?.length) {
    console.error('[checkout-recommendations] recommendation errors', errors);
  }

  return data?.productRecommendations || [];
};

// Settings + extra rules configured in the app's Checkout Recommendations page,
// stored in a storefront-readable SHOP metafield. This is the source of truth
// for all merchant config; returns {} if unset/unreadable so the extension
// still renders metaobject / API recommendations with sensible defaults.
const APP_CONFIG_QUERY = `
  query CheckoutRecsAppConfig {
    shop {
      metafield(namespace: "$app:checkout-recommendations", key: "config") {
        value
      }
    }
  }
`;

const fetchAppConfig = async () => {
  try {
    const { data, errors } = await shopify.query(APP_CONFIG_QUERY);

    if (errors?.length) {
      console.error('[checkout-recommendations] app config errors', errors);
    }

    const raw = data?.shop?.metafield?.value;

    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('[checkout-recommendations] app config fetch failed', err);

    return {};
  }
};

// ---------------------------------------------------------------------------
// Rule parsing / matching (ported from the theme lib)
// ---------------------------------------------------------------------------

const parseMetaobject = (node) => {
  const byKey = (node.fields || []).reduce((acc, field) => {
    acc[field.key] = field;

    return acc;
  }, {});

  const getValue = (key) => byKey[key]?.value;
  const getRefs = (key) => (byKey[key]?.references?.nodes || []).filter(Boolean);

  const rawPriority = parseInt(getValue('priority'), 10);
  const priority = Number.isFinite(rawPriority) ? rawPriority : Number.MAX_SAFE_INTEGER;

  return {
    id: node.id,
    handle: node.handle,
    // `active` is preferred; fall back to legacy keys.
    active: parseBool(getValue('active') ?? getValue('activate_recommendation') ?? getValue('activate')),
    priority,
    useTimeSettings: parseBool(getValue('use_time_settings')),
    activeFrom: getValue('active_from') || null,
    activeTill: getValue('active_till') || null,
    productsInCart: getRefs('products_in_cart').map((p) => p?.handle).filter(Boolean),
    productTypesInCart: parseStringList(getValue('product_types_in_cart')),
    productTagsInCart: parseStringList(getValue('product_tags_in_cart')),
    showRecommendations: getRefs('show_recommendations'),
  };
};

const ruleMatchesCart = (rule, { handles, types, tags }) => {
  if (rule.productsInCart.length && rule.productsInCart.some((h) => handles.has(String(h).toLowerCase()))) {
    return true;
  }

  if (rule.productTypesInCart.length && rule.productTypesInCart.some((t) => types.has(String(t).toLowerCase()))) {
    return true;
  }

  if (rule.productTagsInCart.length && rule.productTagsInCart.some((t) => tags.has(String(t).toLowerCase()))) {
    return true;
  }

  return false;
};

// Shopify represents single-variant products with one synthetic "Title /
// Default Title" option; we hide it so those products skip the picker.
const isDefaultOption = (option) =>
  String(option?.name).toLowerCase() === 'title' &&
  String(option?.value).toLowerCase() === 'default title';

// Reshape a Storefront product into the flat card shape the UI renders. Carries
// every purchasable variant (with its per-option values) plus the option axes
// (e.g. "Bra Size", "Brief Size") so the picker can render a button row per
// option. The default (first available) variant drives the card's price.
const toCard = (product) => {
  const allVariants = (product?.variants?.nodes || []).filter((v) => v?.id);
  const available = allVariants.filter((v) => v.availableForSale);

  // Skip products with nothing buyable rather than show a dead "Add" button.
  if (!product?.id || !available.length) return null;

  const variants = available.map((v) => {
    const optionValues = {};
    (v.selectedOptions || []).forEach((o) => {
      if (!isDefaultOption(o)) optionValues[o.name] = o.value;
    });

    return {
      id: v.id,
      price: v.price?.amount ?? '0.00',
      compareAtPrice: v.compareAtPrice?.amount ?? null,
      optionValues,
    };
  });

  // Option axes + their distinct values, in first-seen order across the
  // available variants (so each axis becomes one row of buttons).
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

  const defaultVariant = variants[0];

  return {
    productId: product.id,
    variantId: defaultVariant.id,
    title: product.title || '',
    productType: product.productType || '',
    imageUrl: product.featuredImage?.url || '',
    imageAlt: product.featuredImage?.altText || product.title || 'Product image',
    price: defaultVariant.price,
    compareAtPrice: defaultVariant.compareAtPrice,
    variants,
    options,
    hasOptions: options.length > 0,
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

// The buyer's default selection: the option values of the default variant.
const defaultSelection = (card) => {
  const variant = card.variants.find((v) => v.id === card.variantId) || card.variants[0];
  const selection = {};
  card.options.forEach((o) => { selection[o.name] = variant?.optionValues[o.name]; });

  return selection;
};

/**
 * Resolve checkout recommendations.
 *
 * Order of precedence (mirrors the theme mini-cart):
 *   0. The active range motivator's curated products, pinned to the top in
 *      configured order. These ignore the Max Slots cap (always shown in full).
 *   1. Manual upsells configured in the app's Checkout Recommendations page.
 *   2. Active `mini_cart_recommendations` metaobjects whose conditions match
 *      the cart (products / product types / tags in cart).
 *   3. Shopify product recommendations seeded by the first cart item fill any
 *      remaining slots.
 *
 * Tiers 1-3 stop once Max Slots is reached; the motivator products in tier 0 are
 * exempt, so the rendered count can exceed Max Slots when a motivator is active.
 *
 * Cart products are always excluded. Lingerie sets and gift cards are excluded
 * from the automatic tiers, but allowed for manual upsells and motivator products
 * (the merchant picked them deliberately; the buyer picks a size at checkout).
 */
const resolveRecommendations = async ({ metaType, countryCode, slotLimit, lines, manualProductIds, motivatorProductIds }) => {
  const cartProductIds = [...new Set(lines.map((l) => l.merchandise?.product?.id).filter(Boolean))];
  const cartTypes = new Set(
    lines.map((l) => String(l.merchandise?.product?.productType || '').toLowerCase()).filter(Boolean)
  );

  const [manualProducts, motivatorProducts, metaNodes, cartDetails] = await Promise.all([
    fetchProductsByIds(manualProductIds || [], countryCode),
    fetchProductsByIds(motivatorProductIds || [], countryCode),
    fetchMetaobjects(metaType, countryCode),
    fetchCartProductDetails(cartProductIds, countryCode),
  ]);

  const cartHandles = new Set();
  const cartTags = new Set();

  Object.values(cartDetails).forEach((p) => {
    if (p.handle) cartHandles.add(String(p.handle).toLowerCase());
    (p.tags || []).forEach((t) => cartTags.add(String(t).toLowerCase()));
  });

  const cartProductIdSet = new Set(cartProductIds);
  const collected = [];
  const seenProductIds = new Set();

  // `force` bypasses the Max Slots cap (used for the active motivator's curated
  // products, which always show on top). Cart/dedupe/availability still apply.
  const tryAddCard = (card, { allowAnyType = false, force = false } = {}) => {
    if (!force && collected.length >= slotLimit) return;
    if (!card) return;
    if (cartProductIdSet.has(card.productId)) return;
    if (seenProductIds.has(card.productId)) return;
    if (!allowAnyType && isQuickAddIneligibleType(card.productType)) return;

    seenProductIds.add(card.productId);
    collected.push(card);
  };

  const tryAdd = (product) => tryAddCard(toCard(product));

  // 0. Active range motivator: surface ALL of its curated products at the very
  // top, in the merchant's configured order. These bypass the type filter (like
  // manual upsells) and, via `force`, the Max Slots cap - the curated set always
  // shows in full; the tiers below fill any remaining slots up to Max Slots.
  motivatorProducts.forEach((product) =>
    tryAddCard(toCard(product), { allowAnyType: true, force: true })
  );

  // 1. Manual upsells next, in configured order. These bypass the type filter.
  manualProducts.forEach((product) => tryAddCard(toCard(product), { allowAnyType: true }));

  // 2. Metaobject rules, highest priority first.
  metaNodes
    .map(parseMetaobject)
    .filter((rule) =>
      rule.active &&
      (!rule.useTimeSettings || isWithinTimeWindow(rule.activeFrom, rule.activeTill)) &&
      ruleMatchesCart(rule, { handles: cartHandles, types: cartTypes, tags: cartTags })
    )
    .sort((a, b) => a.priority - b.priority)
    .forEach((rule) => rule.showRecommendations.forEach(tryAdd));

  // 3. Shopify product recommendations, seeded by the first cart item.
  if (collected.length < slotLimit && cartProductIds.length > 0) {
    const recs = await fetchProductRecommendations(cartProductIds[0], countryCode);

    recs.forEach(tryAdd);
  }

  return collected;
};

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function Extension() {
  const lines = shopify.lines.value;
  const settings = shopify.settings.value || {};
  const countryCode = shopify.localization?.country?.value?.isoCode;
  const subtotal = shopify.cost?.subtotalAmount?.value;

  const currencyCode = subtotal?.currencyCode;

  // Merchant-set debug toggle (the only extension setting). When on, a
  // diagnostics panel renders even if there are no recommendation cards.
  const showTesting = Boolean(settings.show_testing_information);

  // App config (Checkout Recommendations admin page) is the source of truth for
  // all merchant settings; defaults apply until it's populated.
  const [appConfig, setAppConfig] = useState(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetchAppConfig().then((cfg) => {
      if (!cancelled) {
        setAppConfig(cfg);
        setConfigLoaded(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const heading = appConfig?.heading || 'You May Also Like';
  const metaType = appConfig?.metaobject_type || DEFAULT_META_TYPE;
  const slotLimit = Number(appConfig?.max_products) || DEFAULT_MAX_SLOTS;

  const subtotalAmount = Number(subtotal?.amount);

  // Rule: Price Range Motivator. The active motivator (if any) for the buyer's
  // currency drives both the header message and the curated recommendations.
  const activeMotivator = pickActiveMotivator(appConfig?.motivators, currencyCode, subtotalAmount);

  // Header subtitle: an active motivator's message wins; otherwise fall back to
  // the generic free-shipping nudge from the threshold settings.
  const thresholds = resolveShippingThresholds(appConfig, currencyCode);
  const fallbackShipping = getShippingInfo(thresholds, subtotal);
  const shippingSubtitle = activeMotivator
    ? renderMotivatorText(activeMotivator.motivator.text, activeMotivator.remaining)
    : fallbackShipping.subtitle;

  const manualProductIds = (appConfig?.manual_upsells || []).filter(Boolean);

  // Curated products for the active motivator. When a motivator is active the
  // resolver pins all of these to the top, ignoring Max Slots. `motivatorGap` (the
  // spend left to the target) is kept for the testing panel only.
  const motivatorProductIds = activeMotivator ? activeMotivator.motivator.products || [] : [];
  const motivatorGap = activeMotivator ? activeMotivator.remaining : 0;

  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(null);
  const [showError, setShowError] = useState(false);

  // Recompute whenever the cart line-up changes.
  const cartKey = useMemo(
    () => lines.map((l) => `${l.merchandise?.id}:${l.quantity}`).join('|'),
    [lines]
  );
  const manualKey = manualProductIds.join('|');
  // Resolution no longer depends on the gap amount, only on which curated
  // products the active motivator pins to the top.
  const motivatorKey = motivatorProductIds.join('|');

  useEffect(() => {
    // Wait for the config fetch to settle so we resolve once with the final
    // settings (config fetch returns {} on error, so this never hangs).
    if (!configLoaded) return undefined;

    let cancelled = false;

    setLoading(true);

    resolveRecommendations({
      metaType,
      countryCode,
      slotLimit,
      lines,
      manualProductIds,
      motivatorProductIds,
    })
      .then((result) => {
        if (!cancelled) setCards(result);
      })
      .catch((err) => {
        console.error('[checkout-recommendations] resolve failed', err);
        if (!cancelled) setCards([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [configLoaded, cartKey, metaType, countryCode, slotLimit, manualKey, motivatorKey]);

  // Hide the error banner automatically after 3s.
  useEffect(() => {
    if (!showError) return undefined;

    const timer = setTimeout(() => setShowError(false), 3000);

    return () => clearTimeout(timer);
  }, [showError]);

  // Adds the chosen variant (the buyer's size pick, or the default for
  // single-variant products). `variant` is a card.variants entry.
  const handleAddToCart = async (variant) => {
    setAdding(variant.id);

    const compareAtNum = Number(variant.compareAtPrice);
    const hasCompareAt = Number.isFinite(compareAtNum) && compareAtNum > Number(variant.price);
    const compareAtCents = hasCompareAt ? Math.round(compareAtNum * 100) : 0;

    const attributes = [
      { key: '_checkout_upsell', value: 'true' },
      { key: '_addSource', value: 'Checkout:Recommended' },
      ...(hasCompareAt
        ? [
            { key: '__originPrice', value: String(compareAtCents) },
            { key: 'Original Price', value: shopify.i18n.formatCurrency(compareAtNum) },
          ]
        : []),
    ];

    const result = await shopify.applyCartLinesChange({
      type: 'addCartLine',
      merchandiseId: variant.id,
      quantity: 1,
      attributes,
    });

    setAdding(null);

    if (result.type === 'error') {
      setShowError(true);
      console.error(result.message);
    }
  };

  // Diagnostics panel (rendered only when the merchant enables the debug
  // toggle). Surfaces the state the resolver acted on so misconfigured or
  // non-matching configs are visible instead of silently rendering nothing.
  const debugPanel = showTesting ? (
    <DebugPanel
      configLoaded={configLoaded}
      appConfig={appConfig}
      countryCode={countryCode}
      currencyCode={currencyCode}
      subtotalAmount={subtotalAmount}
      thresholds={thresholds}
      activeMotivator={activeMotivator}
      manualProductIds={manualProductIds}
      motivatorProductIds={motivatorProductIds}
      motivatorGap={motivatorGap}
      heading={heading}
      metaType={metaType}
      slotLimit={slotLimit}
      loading={loading}
      cardCount={cards.length}
    />
  ) : null;

  let content = null;

  if (loading) {
    content = <RecommendationsSkeleton heading={heading} subtitle={shippingSubtitle} />;
  } else if (cards.length) {
    content = (
      <>
        <Header heading={heading} subtitle={shippingSubtitle} />

        <s-scroll-box maxBlockSize="400px" padding="none">
          <s-stack gap="base">
            {cards.map((card) => (
              <RecommendationCard
                key={card.productId}
                card={card}
                addingVariantId={adding}
                onAdd={handleAddToCart}
              />
            ))}
          </s-stack>
        </s-scroll-box>

        {showError && (
          <s-banner tone="critical">
            There was an issue adding this product. Please try again.
          </s-banner>
        )}
      </>
    );
  }

  // Nothing to show and debugging is off: render nothing.
  if (!content && !debugPanel) return null;

  return (
    <s-stack gap="base">
      {content}
      {debugPanel}
    </s-stack>
  );
}

function Header({ heading, subtitle }) {
  return (
    <s-stack gap="small-500">
      <s-heading>{heading}</s-heading>
      {subtitle && <s-text color="subdued">{subtitle}</s-text>}
    </s-stack>
  );
}

function RecommendationCard({ card, addingVariantId, onAdd }) {
  // Buyer's per-option picks (defaults to the card's default variant). For
  // single-variant products `options` is empty and the button adds directly.
  const [selection, setSelection] = useState(() => defaultSelection(card));
  const selected =
    findVariant(card, selection) ||
    card.variants.find((v) => v.id === card.variantId) ||
    card.variants[0];

  const isOnSale =
    selected?.compareAtPrice != null && Number(selected.compareAtPrice) > Number(selected.price);

  const finalImageUrl = card.imageUrl
    ? `${card.imageUrl}${card.imageUrl.includes('?') ? '&' : '?'}width=200&height=200&crop=center`
    : 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png';

  // Larger image for the modal hero (full width).
  const modalImageUrl = card.imageUrl
    ? `${card.imageUrl}${card.imageUrl.includes('?') ? '&' : '?'}width=600&height=600&crop=center`
    : finalImageUrl;

  const adding = addingVariantId != null && selected != null && addingVariantId === selected.id;
  // s-modal needs a DOM-safe id; product gids contain "/" and ":".
  const modalId = `rec-${String(card.productId).replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <>
      <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center">
        <s-box inlineSize="64px">
          <s-image
            src={finalImageUrl}
            alt={card.imageAlt}
            aspectRatio="1"
            objectFit="cover"
            inlineSize="fill"
            borderRadius="base"
          />
        </s-box>

        <s-stack gap="small-500">
          <s-heading>{card.title}</s-heading>
          <s-stack direction="inline" gap="small-300">
            <s-text color="subdued">{formatPrice(selected?.price ?? card.price)}</s-text>
            {isOnSale && (
              <s-text color="subdued" type="redundant">
                {formatPrice(selected.compareAtPrice)}
              </s-text>
            )}
          </s-stack>
        </s-stack>

        {card.hasOptions ? (
          // Multi-variant: open the size picker instead of adding blindly.
          <s-button variant="secondary" command="--show" commandFor={modalId}>
            {shopify.i18n.translate('add-to-cart')}
          </s-button>
        ) : (
          <s-button variant="secondary" loading={adding} onClick={() => onAdd(selected)}>
            {shopify.i18n.translate('add-to-cart')}
          </s-button>
        )}
      </s-grid>

      {card.hasOptions && (
        <s-modal id={modalId} padding="none" accessibilityLabel={card.title}>
          {/* Full-width product image above the title. */}
          <s-image
            src={modalImageUrl}
            alt={card.imageAlt}
            aspectRatio="1"
            objectFit="cover"
            inlineSize="fill"
          />

          <s-box padding="base">
            <s-stack gap="base">
              {/* Bold title with the (selected) price to the right. */}
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-text type="strong">{card.title}</s-text>
                <s-text type="strong">{formatPrice(selected?.price ?? card.price)}</s-text>
              </s-stack>

              {/* One row of selector buttons per option (e.g. Bra Size, Brief Size). */}
              {card.options.map((option) => (
                <s-stack key={option.name} gap="small-300">
                  <s-text color="subdued">{option.name}</s-text>
                  <s-grid
                    gridTemplateColumns="repeat(auto-fit, minmax(64px, 1fr))"
                    gap="small-300"
                  >
                    {option.values.map((value) => (
                      <s-button
                        key={value}
                        variant={selection[option.name] === value ? 'primary' : 'secondary'}
                        disabled={!valueIsAvailable(card, selection, option, value)}
                        onClick={() =>
                          setSelection((prev) => reconcileSelection(card, prev, option.name, value))
                        }
                      >
                        {value}
                      </s-button>
                    ))}
                  </s-grid>
                </s-stack>
              ))}
            </s-stack>
          </s-box>

          {/* Full-width primary add-to-cart bar. */}
          <s-button
            slot="primary-action"
            variant="primary"
            inlineSize="fill"
            command="--hide"
            commandFor={modalId}
            onClick={() => onAdd(selected)}
          >
            {shopify.i18n.translate('add-to-cart')}
          </s-button>
        </s-modal>
      )}
    </>
  );
}

function RecommendationsSkeleton({ heading, subtitle }) {
  return (
    <s-stack gap="base">
      <Header heading={heading} subtitle={subtitle} />
      <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center">
        <s-box inlineSize="64px">
          <s-image aspectRatio="1" inlineSize="fill" borderRadius="base" />
        </s-box>
        <s-skeleton-paragraph />
        <s-button variant="secondary" disabled>
          {shopify.i18n.translate('add-to-cart')}
        </s-button>
      </s-grid>
    </s-stack>
  );
}

// Diagnostics panel shown when the merchant flips "Show Testing Information?".
// Mirrors the gift-with-purchase debug pattern: dotted border, small text, and
// every input the resolver used so a non-appearing config is explainable.
function DebugPanel({
  configLoaded,
  appConfig,
  countryCode,
  currencyCode,
  subtotalAmount,
  thresholds,
  activeMotivator,
  manualProductIds,
  motivatorProductIds,
  motivatorGap,
  heading,
  metaType,
  slotLimit,
  loading,
  cardCount,
}) {
  const cfg = appConfig || {};
  const motivators = cfg.motivators;
  const motivatorLines = describeMotivators(motivators, currencyCode, subtotalAmount);
  const configKeys = Object.keys(cfg);

  const line = (text) => <s-text color="subdued">{text}</s-text>;

  return (
    <s-box border="base base dotted" borderRadius="base" padding="base">
      <s-stack gap="small-300">
        <s-text type="strong">Checkout Recommendations - testing</s-text>

        {line(`Config loaded: ${configLoaded ? 'yes' : 'no'} | keys: ${configKeys.length ? configKeys.join(', ') : '(empty)'}`)}
        {line(`Country: ${countryCode || '-'} | Currency: ${currencyCode || '-'} | Subtotal: ${Number.isFinite(subtotalAmount) ? subtotalAmount : '-'}`)}
        {line(`Heading: "${heading}" | Meta type: ${metaType} | Max slots: ${slotLimit}`)}
        {line(`Resolving: ${loading ? 'yes' : 'no'} | Cards resolved: ${cardCount}`)}
        {line(`Thresholds (${currencyCode || '-'}): standard ${thresholds.standard || 0}, express ${thresholds.express || 0}`)}
        {line(`Manual upsells: ${manualProductIds.length} | Motivator products: ${motivatorProductIds.length} (gap ${motivatorGap || 0})`)}

        <s-text type="strong">Motivators ({Array.isArray(motivators) ? motivators.length : 0})</s-text>
        {motivatorLines.map((text, i) => (
          <s-text key={i} color="subdued">{text}</s-text>
        ))}

        {line(
          activeMotivator
            ? `Active motivator: MATCH (remaining ${activeMotivator.remaining}) -> "${activeMotivator.motivator?.text || ''}"`
            : 'Active motivator: none'
        )}

        {cardCount === 0 && !loading
          ? line('No cards: nothing would render without this panel. Check config loaded, currency match, subtotal range, and that metaobjects / recommendations resolved.')
          : null}
      </s-stack>
    </s-box>
  );
}
