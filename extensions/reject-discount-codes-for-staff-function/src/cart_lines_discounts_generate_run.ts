import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from '../generated/api';

const MESSAGE = "Sorry Honey, you can't use your staff discount with certain items in your cart.";

// Rejects every entered discount code when a customer tagged "Honey Birdette Staff"
// has a product tagged "stop-staff-discount-code" in the cart.
export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.cart.buyerIdentity?.customer?.isStaff) {
    return {operations: []};
  }

  const restrictedTitles: string[] = [];
  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (!('product' in merchandise) || !merchandise.product.stopStaffDiscount) continue;
    const title = merchandise.product.title;
    if (!restrictedTitles.includes(title)) restrictedTitles.push(title);
  }

  if (!restrictedTitles.length) {
    return {operations: []};
  }

  const codesToReject = input.enteredDiscountCodes
    .filter((dc) => dc.rejectable)
    .map((dc) => ({code: dc.code}));

  if (!codesToReject.length) {
    return {operations: []};
  }

  // Append product names while the message stays within the 120 char limit
  let message = MESSAGE;
  const fittingTitles: string[] = [];
  for (const title of restrictedTitles) {
    if (`${MESSAGE} (${[...fittingTitles, title].join(', ')})`.length > 120) break;
    fittingTitles.push(title);
  }
  if (fittingTitles.length) {
    message = `${MESSAGE} (${fittingTitles.join(', ')})`;
  }

  return {
    operations: [
      {
        enteredDiscountCodesReject: {
          message,
          codes: codesToReject,
        },
      },
    ],
  };
}
