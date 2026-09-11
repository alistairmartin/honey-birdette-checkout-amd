import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";
import { CountryCode } from "../generated/api";

// Countries where the warehouse and courier need a Latin-script address.
// Hong Kong is officially bilingual, so every address has an English form.
const ENFORCED_COUNTRIES = new Set<CountryCode>([CountryCode.Hk]);

// Set to true to also require first name and last name in English.
const CHECK_NAME_FIELDS = false;

const ADDRESS_FIELDS = ["address1", "address2", "city", "company"] as const;
const NAME_FIELDS = ["firstName", "lastName"] as const;

// CJK ideographs (incl. extensions), CJK punctuation, and full-width forms.
const NON_LATIN_PATTERN =
  /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{2FFFF}]/u;

const MESSAGE =
  "Please enter this in English so our courier can deliver your order. 請以英文填寫，以便快遞派送。";

export function cartValidationsGenerateRun(
  input: CartValidationsGenerateRunInput,
): CartValidationsGenerateRunResult {
  const errors: ValidationError[] = [];

  input.cart.deliveryGroups.forEach((group, index) => {
    const address = group.deliveryAddress;
    const countryCode = address?.countryCode;
    if (!address || countryCode == null || !ENFORCED_COUNTRIES.has(countryCode)) {
      return;
    }

    const fields: readonly string[] = CHECK_NAME_FIELDS
      ? [...ADDRESS_FIELDS, ...NAME_FIELDS]
      : ADDRESS_FIELDS;

    for (const field of fields) {
      const value = (address as Record<string, string | null | undefined>)[field];
      if (value && NON_LATIN_PATTERN.test(value)) {
        errors.push({
          message: MESSAGE,
          target: `$.cart.deliveryGroups[${index}].deliveryAddress.${field}`,
        });
      }
    }
  });

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
