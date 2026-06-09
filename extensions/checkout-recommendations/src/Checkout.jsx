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

const getShippingSubtitle = (settings, subtotal) => {
  if (!subtotal) return null;

  const currency = String(subtotal.currencyCode || '').toLowerCase();

  const tiers = SHIPPING_TIERS.map((tier) => ({
    threshold: Number(settings[`free_${tier.suffix}_${currency}`]),
    message: tier.message,
  }))
    .filter((tier) => Number.isFinite(tier.threshold) && tier.threshold > 0)
    .sort((a, b) => a.threshold - b.threshold);

  if (!tiers.length) return null;

  // First tier the buyer hasn't cleared yet.
  const nextTier = tiers.find((tier) => subtotal.amount < tier.threshold);

  if (!nextTier) {
    return "You've got free shipping honey!";
  }

  return `Spend ${formatPrice(nextTier.threshold - subtotal.amount)} more to get ${nextTier.message}`;
};

// ---------------------------------------------------------------------------
// GraphQL (Storefront API via `shopify.query`)
// ---------------------------------------------------------------------------

// Streamlined product fields needed to render a card + add the default variant.
const PRODUCT_CARD_FIELDS = `
  id
  title
  handle
  productType
  tags
  featuredImage { url altText }
  variants(first: 1) {
    nodes {
      id
      availableForSale
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

// Manual upsells are explicit variant references, so we fetch the chosen
// variant directly (rather than a product's default variant).
const fetchManualUpsells = async (variantIds, countryCode) => {
  if (!variantIds.length) return [];

  const query = `
    query ManualUpsells($ids: [ID!]!) ${inContext(countryCode)} {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          availableForSale
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          image { url altText }
          product {
            id
            title
            productType
            featuredImage { url altText }
          }
        }
      }
    }
  `;

  const { data, errors } = await shopify.query(query, { variables: { ids: variantIds } });

  if (errors?.length) {
    console.error('[checkout-recommendations] manual upsell errors', errors);
  }

  // Preserve the merchant's configured order, dropping any that didn't resolve.
  const byId = {};

  (data?.nodes || []).filter(Boolean).forEach((v) => {
    byId[v.id] = v;
  });

  return variantIds.map((id) => byId[id]).filter(Boolean);
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

// Reshape a Storefront product into the flat card shape the UI renders.
const toCard = (product) => {
  const variant = product?.variants?.nodes?.[0];

  if (!product?.id || !variant?.id) return null;

  return {
    productId: product.id,
    variantId: variant.id,
    title: product.title || '',
    productType: product.productType || '',
    imageUrl: product.featuredImage?.url || '',
    imageAlt: product.featuredImage?.altText || product.title || 'Product image',
    price: variant.price?.amount ?? '0.00',
    compareAtPrice: variant.compareAtPrice?.amount ?? null,
  };
};

// Reshape a Storefront variant (manual upsell) into the same card shape.
const toVariantCard = (variant) => {
  const product = variant?.product;

  if (!variant?.id || !product?.id) return null;

  return {
    productId: product.id,
    variantId: variant.id,
    title: product.title || '',
    productType: product.productType || '',
    imageUrl: variant.image?.url || product.featuredImage?.url || '',
    imageAlt: variant.image?.altText || product.featuredImage?.altText || product.title || 'Product image',
    price: variant.price?.amount ?? '0.00',
    compareAtPrice: variant.compareAtPrice?.amount ?? null,
  };
};

/**
 * Resolve checkout recommendations.
 *
 * Order of precedence (mirrors the theme mini-cart):
 *   1. Manual upsells configured in the extension settings.
 *   2. Active `mini_cart_recommendations` metaobjects whose conditions match
 *      the cart (products / product types / tags in cart).
 *   3. Shopify product recommendations seeded by the first cart item fill any
 *      remaining slots.
 *
 * Cart products are always excluded. Lingerie sets and gift cards are excluded
 * from the automatic tiers, but allowed for manual upsells (the merchant picked
 * an exact variant, so the size-selection concern doesn't apply).
 */
const resolveRecommendations = async ({ metaType, countryCode, slotLimit, lines, manualVariantIds }) => {
  const cartProductIds = [...new Set(lines.map((l) => l.merchandise?.product?.id).filter(Boolean))];
  const cartTypes = new Set(
    lines.map((l) => String(l.merchandise?.product?.productType || '').toLowerCase()).filter(Boolean)
  );

  const [manualVariants, metaNodes, cartDetails] = await Promise.all([
    fetchManualUpsells(manualVariantIds, countryCode),
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

  const tryAddCard = (card, { allowAnyType = false } = {}) => {
    if (collected.length >= slotLimit) return;
    if (!card) return;
    if (cartProductIdSet.has(card.productId)) return;
    if (seenProductIds.has(card.productId)) return;
    if (!allowAnyType && isQuickAddIneligibleType(card.productType)) return;

    seenProductIds.add(card.productId);
    collected.push(card);
  };

  const tryAdd = (product) => tryAddCard(toCard(product));

  // 1. Manual upsells first, in configured order. These bypass the type filter.
  manualVariants.forEach((variant) => tryAddCard(toVariantCard(variant), { allowAnyType: true }));

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

  const heading = settings.heading || 'You May Also Like';
  const metaType = settings.metaobject_type || DEFAULT_META_TYPE;
  const slotLimit = Number(settings.max_products) || DEFAULT_MAX_SLOTS;
  const shippingSubtitle = getShippingSubtitle(settings, subtotal);

  const manualVariantIds = [
    settings.manual_product1,
    settings.manual_product2,
    settings.manual_product3,
    settings.manual_product4,
  ].filter(Boolean);

  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(null);
  const [showError, setShowError] = useState(false);

  // Recompute whenever the cart line-up changes.
  const cartKey = useMemo(
    () => lines.map((l) => `${l.merchandise?.id}:${l.quantity}`).join('|'),
    [lines]
  );
  const manualKey = manualVariantIds.join('|');

  useEffect(() => {
    let cancelled = false;

    setLoading(true);

    resolveRecommendations({ metaType, countryCode, slotLimit, lines, manualVariantIds })
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
  }, [cartKey, metaType, countryCode, slotLimit, manualKey]);

  // Hide the error banner automatically after 3s.
  useEffect(() => {
    if (!showError) return undefined;

    const timer = setTimeout(() => setShowError(false), 3000);

    return () => clearTimeout(timer);
  }, [showError]);

  const handleAddToCart = async (card) => {
    setAdding(card.variantId);

    const compareAtNum = Number(card.compareAtPrice);
    const hasCompareAt = Number.isFinite(compareAtNum) && compareAtNum > Number(card.price);
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
      merchandiseId: card.variantId,
      quantity: 1,
      attributes,
    });

    setAdding(null);

    if (result.type === 'error') {
      setShowError(true);
      console.error(result.message);
    }
  };

  if (loading) {
    return <RecommendationsSkeleton heading={heading} subtitle={shippingSubtitle} />;
  }

  if (!cards.length) {
    return null;
  }

  return (
    <s-stack gap="base">
      <Header heading={heading} subtitle={shippingSubtitle} />

      <s-scroll-box maxBlockSize="400px" padding="none">
        <s-stack gap="base">
          {cards.map((card) => (
            <RecommendationCard
              key={card.variantId}
              card={card}
              adding={adding === card.variantId}
              onAdd={() => handleAddToCart(card)}
            />
          ))}
        </s-stack>
      </s-scroll-box>

      {showError && (
        <s-banner tone="critical">
          There was an issue adding this product. Please try again.
        </s-banner>
      )}
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

function RecommendationCard({ card, adding, onAdd }) {
  const isOnSale =
    card.compareAtPrice != null && Number(card.compareAtPrice) > Number(card.price);

  const finalImageUrl = card.imageUrl
    ? `${card.imageUrl}${card.imageUrl.includes('?') ? '&' : '?'}width=200&height=200&crop=center`
    : 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png';

  return (
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
          <s-text color="subdued">{formatPrice(card.price)}</s-text>
          {isOnSale && (
            <s-text color="subdued" type="redundant">
              {formatPrice(card.compareAtPrice)}
            </s-text>
          )}
        </s-stack>
      </s-stack>

      <s-button variant="secondary" loading={adding} onClick={onAdd}>
        {shopify.i18n.translate('add-to-cart')}
      </s-button>
    </s-grid>
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
