import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
  DeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
} from "../generated/api";

const STAFF_EMAIL_DOMAINS = ["@honeybirdette.com.au", "@honeybirdette.com"];

function getShippingTitle(metafieldValue: string | null | undefined): string | null {
  if (!metafieldValue) return null;
  try {
    const config = JSON.parse(metafieldValue);
    return typeof config.shippingTitle === "string" ? config.shippingTitle : null;
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

  const email = input.cart.buyerIdentity?.email;
  const isStaffEmail =
    email != null &&
    STAFF_EMAIL_DOMAINS.some((domain) => email.endsWith(domain));

  const hasStaffTag = input.cart.buyerIdentity?.customer?.hasStaffTag === true;

  if (!isStaffEmail && !hasStaffTag) {
    return {operations: []};
  }

  const shippingTitle = getShippingTitle(input.discount.metafield?.value);
  if (!shippingTitle) {
    return {operations: []};
  }

  const candidates = input.cart.deliveryGroups.flatMap((group) =>
    group.deliveryOptions
      .filter((option) => option.title === shippingTitle)
      .map((option) => ({
        message: "FREE Shipping For HB Staff",
        targets: [
          {
            deliveryOption: {
              handle: option.handle,
            },
          },
        ],
        value: {
          percentage: {
            value: 100,
          },
        },
      })),
  );

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