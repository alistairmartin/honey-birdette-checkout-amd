import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
  DeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
} from "../generated/api";

/**
 * Configuration written by free-shipping-with-product-ui into the
 * $app:function-configuration metafield on the discount.
 *
 * - productIds: product GIDs; any one of them in the cart qualifies.
 * - shippingTitles: exact delivery option titles to make free.
 * - includeCountries: ISO codes; if non-empty, only these countries qualify.
 * - excludeCountries: ISO codes that never qualify (checked after include).
 * - message: label shown at checkout next to the discounted rate.
 */
type Config = {
  productIds: string[];
  shippingTitles: string[];
  includeCountries: string[];
  excludeCountries: string[];
  message: string;
};

const DEFAULT_MESSAGE = "FREE Shipping";

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseConfig(metafieldValue: string | null | undefined): Config | null {
  if (!metafieldValue) return null;
  try {
    const raw = JSON.parse(metafieldValue);
    const config: Config = {
      productIds: asStringArray(raw.productIds),
      shippingTitles: asStringArray(raw.shippingTitles),
      includeCountries: asStringArray(raw.includeCountries).map((c) => c.toUpperCase()),
      excludeCountries: asStringArray(raw.excludeCountries).map((c) => c.toUpperCase()),
      message:
        typeof raw.message === "string" && raw.message.trim().length > 0
          ? raw.message.trim()
          : DEFAULT_MESSAGE,
    };
    if (config.productIds.length === 0 || config.shippingTitles.length === 0) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

export function cartDeliveryOptionsDiscountsGenerateRun(
  input: DeliveryInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  const hasShippingDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Shipping,
  );
  if (!hasShippingDiscountClass) {
    return {operations: []};
  }

  const config = parseConfig(input.discount.metafield?.value);
  if (!config) {
    return {operations: []};
  }

  const productIds = new Set(config.productIds);
  const hasQualifyingProduct = input.cart.lines.some((line) => {
    if (line.quantity <= 0) return false;
    const merchandise = line.merchandise;
    if (merchandise.__typename !== "ProductVariant") return false;
    return productIds.has(merchandise.product.id) || productIds.has(merchandise.id);
  });
  if (!hasQualifyingProduct) {
    return {operations: []};
  }

  const shippingTitles = new Set(config.shippingTitles);
  const include = new Set(config.includeCountries);
  const exclude = new Set(config.excludeCountries);

  const candidates = input.cart.deliveryGroups.flatMap((group) => {
    const country = group.deliveryAddress?.countryCode
      ? String(group.deliveryAddress.countryCode).toUpperCase()
      : null;

    if (include.size > 0 && (country === null || !include.has(country))) {
      return [];
    }
    if (country !== null && exclude.has(country)) {
      return [];
    }

    return group.deliveryOptions
      .filter((option) => shippingTitles.has(option.title))
      .map((option) => ({
        message: config.message,
        targets: [{deliveryOption: {handle: option.handle}}],
        value: {percentage: {value: 100}},
      }));
  });

  if (candidates.length === 0) {
    return {operations: []};
  }

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates,
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
