import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const errors: ValidationError[] = input.cart.lines
    .filter(({ quantity, merchandise }) =>
      merchandise.__typename === "ProductVariant" &&
      merchandise.product.hasAnyTag &&
      quantity > 1
    )
    .map(({ merchandise }) => ({
      message: `${merchandise.__typename === "ProductVariant" ? merchandise.product.title : "This product"} is limited to 1 per order`,
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