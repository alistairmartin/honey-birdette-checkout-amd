import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const hasGiftCard = input.cart.lines.some((line) => {
    const merchandise = line.merchandise;
    return merchandise.__typename === "ProductVariant" && merchandise.product.isGiftCard;
  });

  const hasDiscount = input.cart.lines.some((line) => {
    const subtotal = parseFloat(line.cost.subtotalAmount.amount);
    const total = parseFloat(line.cost.totalAmount.amount);
    return total < subtotal;
  });

  const errors: ValidationError[] = hasGiftCard && hasDiscount
    ? [{ message: "Discount codes cannot be used when purchasing gift cards.", target: "$.cart" }]
    : [];

  return {
    operations: [{ validationAdd: { errors } }],
  };
};