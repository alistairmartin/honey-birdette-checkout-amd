import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";

// Minimum spend to qualify for any free gift (Tier 1 thresholds)
const TIER1_MINIMUMS: Record<string, number> = {
  AUD: 300, NZD: 350, USD: 350, CAD: 470, GBP: 300, EUR: 350, AED: 1600,
};

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const lines = input.cart.lines;

  const isGwp = (line: typeof lines[0]) => {
    const m = line.merchandise;
    return m.__typename === "ProductVariant" && m.product.isGwp === true;
  };

  const gwpLines = lines.filter(isGwp);
  const regularLines = lines.filter(line => !isGwp(line));

  const errors: ValidationError[] = [];

  if (gwpLines.length > 0) {
    // Only 1 free gift allowed
    if (gwpLines.length > 1) {
      errors.push({
        message: "Only one free gift is allowed per order. Please remove the extra gift to proceed.",
        target: "$.cart",
      });
    }

    // Determine currency from the first regular line (or fallback to GWP line)
    const anyLine = regularLines[0] ?? gwpLines[0];
    const currency = anyLine.cost.totalAmount.currencyCode;

    // Sum subtotal of regular (non-gift) lines only
    const subtotal = regularLines.reduce(
      (sum, line) => sum + parseFloat(line.cost.totalAmount.amount),
      0
    );

    const minimum = TIER1_MINIMUMS[currency] ?? TIER1_MINIMUMS["AUD"];

    if (subtotal < minimum) {
      const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "AED" ? "AED " : "$";
      errors.push({
        message: `You need to spend at least ${symbol}${minimum} to qualify for a free gift. Please add more items or remove your free gift to proceed.`,
        target: "$.cart",
      });
    }
  }

  return {
    operations: [{ validationAdd: { errors } }],
  };
};