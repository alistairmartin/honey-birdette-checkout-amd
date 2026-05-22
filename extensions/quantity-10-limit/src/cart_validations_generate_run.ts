import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";

const MAX_QUANTITY_PER_VARIANT = 10;

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  // Aggregate total quantity per variant across all cart lines
  const quantityByVariant = new Map<string, number>();
  for (const line of input.cart.lines) {
    const variantId = line.merchandise.id;
    quantityByVariant.set(variantId, (quantityByVariant.get(variantId) ?? 0) + line.quantity);
  }

  const errors: ValidationError[] = input.cart.lines
    .filter((line) => (quantityByVariant.get(line.merchandise.id) ?? 0) > MAX_QUANTITY_PER_VARIANT)
    .map(() => ({
      message: `A maximum of ${MAX_QUANTITY_PER_VARIANT} of each item can be added to the cart`,
      target: "$.cart",
    }));

  const operations = [
    {
      validationAdd: {
        errors
      },
    },
  ];

  return { operations };
};