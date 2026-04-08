import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";
import { CountryCode } from "../generated/api";

const BLOCKED_COUNTRIES = new Set<CountryCode>([
  CountryCode.Eg, CountryCode.Sa, CountryCode.Ae, CountryCode.Qa,
  CountryCode.Om, CountryCode.Bh, CountryCode.Ye, CountryCode.In,
  CountryCode.Pk, CountryCode.Mv, CountryCode.Th, CountryCode.Vn,
  CountryCode.Id, CountryCode.My, CountryCode.Sy, CountryCode.Iq,
  CountryCode.Af, CountryCode.Tr,
]);

const BLOCKED_US_PROVINCES = new Set(["AL"]);

const BLOCKED_PRODUCT_TYPES = new Set(["Toys", "Bondage"]);

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const hasBlockedProduct = input.cart.lines.some((line) => {
    if (line.merchandise.__typename === "ProductVariant") {
      const productType = line.merchandise.product?.productType;
      return productType != null && BLOCKED_PRODUCT_TYPES.has(productType);
    }
    return false;
  });

  const errors: ValidationError[] = [];

  if (hasBlockedProduct) {
    const deliveryAddress = input.cart.deliveryGroups[0]?.deliveryAddress;
    const countryCode = deliveryAddress?.countryCode;
    const provinceCode = deliveryAddress?.provinceCode;

    const isBlocked =
      (countryCode != null && BLOCKED_COUNTRIES.has(countryCode)) ||
      (countryCode === CountryCode.Us && provinceCode != null && BLOCKED_US_PROVINCES.has(provinceCode));

    if (isBlocked) {
      errors.push({
        message: "Please remove any Toys or Bondage items from your cart before proceeding.",
        target: "$.cart",
      });
    }
  }

  return {
    operations: [
      {
        validationAdd: {
          errors,
        },
      },
    ],
  };
}
