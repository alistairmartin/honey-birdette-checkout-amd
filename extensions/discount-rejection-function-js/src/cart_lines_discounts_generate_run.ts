import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from '../generated/api';

interface Rule {
  tag: string;
  message: string;
}

interface FunctionConfig {
  rules?: Rule[];
}

const DEFAULT_MESSAGE = 'Sorry Honey, discounts codes not allowed on Sale, Gift Cards or Swimwear items.';

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  // tags are injected via input query variables from the metafield
  // rules carry the per-tag messages
  const configValue = input.discount?.metafield?.value;
  const config: FunctionConfig = configValue ? JSON.parse(configValue) : {};
  const rules = config.rules ?? [];

  let matchedMessage = DEFAULT_MESSAGE;
  const restrictedTitles: string[] = [];

  input.cart.lines.forEach((line) => {
    const merchandise = line.merchandise;
    if ('product' in merchandise) {
      const matchedTag = merchandise.product.hasTags.find(({hasTag}) => hasTag);
      if (matchedTag) {
        const rule = rules.find((r) => r.tag === matchedTag.tag);
        if (rule) matchedMessage = rule.message;
        const title = merchandise.product.title;
        if (title && !restrictedTitles.includes(title)) {
          restrictedTitles.push(title);
        }
      }
    }
  });

  const hasRestrictedProduct = restrictedTitles.length > 0;

  if (hasRestrictedProduct && restrictedTitles.length > 0) {
    const fittingTitles: string[] = [];
    for (const title of restrictedTitles) {
      const candidate = `${matchedMessage} (${[...fittingTitles, title].join(', ')})`;
      if (candidate.length <= 120) {
        fittingTitles.push(title);
      } else {
        break;
      }
    }
    if (fittingTitles.length > 0) {
      matchedMessage = `${matchedMessage} (${fittingTitles.join(', ')})`;
    }
  }

  if (!hasRestrictedProduct) {
    return {operations: []};
  }

  const codesToReject = input.enteredDiscountCodes
    .filter((dc) => dc.rejectable)
    .map((dc) => ({code: dc.code}));

  if (!codesToReject.length) {
    return {operations: []};
  }

  return {
    operations: [
      {
        enteredDiscountCodesReject: {
          message: matchedMessage,
          codes: codesToReject,
        },
      },
    ],
  };
}
