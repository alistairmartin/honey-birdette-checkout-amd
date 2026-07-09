import {describe, expect, it} from 'vitest';
import {cartLinesDiscountsGenerateRun} from './cart_lines_discounts_generate_run';

const GIFT = 'gid://shopify/Product/999'; // the DND kit
const VICTORIANA = 'gid://shopify/Product/111'; // tagged gwp-dnd
const OTHER = 'gid://shopify/Product/222'; // untagged
const GIFTCARD = 'gid://shopify/Product/333';

function line(id: string, productId: string, amount: number, isGiftCard = false) {
  return {
    id,
    quantity: 1,
    cost: {subtotalAmount: {amount: String(amount)}},
    merchandise: {
      id: `gid://shopify/ProductVariant/${id}`,
      product: {id: productId, isGiftCard},
    },
  };
}

function run(lines: any[], config: any) {
  const subtotal = lines.reduce((s, l) => s + Number(l.cost.subtotalAmount.amount), 0);
  return cartLinesDiscountsGenerateRun({
    cart: {cost: {subtotalAmount: {amount: String(subtotal), currencyCode: 'AUD'}}, lines},
    discount: {
      discountClasses: ['PRODUCT'],
      metafield: {value: JSON.stringify({configs: [config]})},
    },
  } as any);
}

const baseConfig = {
  enabled: true,
  trigger_type: 'buy_x_and_min_spend',
  discount_percentage: 100,
  thresholds: {AUD: 250},
  productIds: [GIFT],
  qualifying_product_ids: [VICTORIANA],
  message: 'Free DND kit',
};

const discounted = (r: any) => r.operations[0]?.productDiscountsAdd?.candidates ?? [];

describe('buy_x_and_min_spend', () => {
  it('gives the gift with a tagged product plus $250 of anything', () => {
    const r = run(
      [line('a', VICTORIANA, 60), line('b', OTHER, 190), line('g', GIFT, 50)],
      baseConfig,
    );
    expect(discounted(r)).toHaveLength(1);
    expect(discounted(r)[0].targets[0].cartLine.id).toBe('g');
  });

  it('withholds the gift when the tagged product is missing', () => {
    const r = run([line('b', OTHER, 300), line('g', GIFT, 50)], baseConfig);
    expect(discounted(r)).toHaveLength(0);
  });

  it('withholds the gift when spend is under the threshold', () => {
    const r = run([line('a', VICTORIANA, 249), line('g', GIFT, 50)], baseConfig);
    expect(discounted(r)).toHaveLength(0);
  });

  it("does not let the gift's own value reach the threshold", () => {
    // 210 tagged + 50 gift = 260 gross, but only 210 counts.
    const r = run([line('a', VICTORIANA, 210), line('g', GIFT, 50)], baseConfig);
    expect(discounted(r)).toHaveLength(0);
  });

  it('does not let a gift card reach the threshold', () => {
    const r = run(
      [line('a', VICTORIANA, 60), line('c', GIFTCARD, 200, true), line('g', GIFT, 50)],
      baseConfig,
    );
    expect(discounted(r)).toHaveLength(0);
  });

  it('fails closed when the qualifying list is empty (tag resolution failed)', () => {
    const r = run(
      [line('a', VICTORIANA, 300), line('g', GIFT, 50)],
      {...baseConfig, qualifying_product_ids: []},
    );
    expect(discounted(r)).toHaveLength(0);
  });

  it('does not count the gift line itself as the qualifying "buy X" product', () => {
    // Gift product is also in the qualifying set; only the gift is in the cart.
    const r = run(
      [line('b', OTHER, 300), line('g', GIFT, 50)],
      {...baseConfig, qualifying_product_ids: [VICTORIANA, GIFT]},
    );
    expect(discounted(r)).toHaveLength(0);
  });
});

describe('existing triggers are unchanged', () => {
  it('min_spend still ignores qualifying_product_ids', () => {
    const r = run([line('b', OTHER, 300), line('g', GIFT, 50)], {
      ...baseConfig,
      trigger_type: 'min_spend',
    });
    expect(discounted(r)).toHaveLength(1);
  });

  it('buy_x_get_y still applies without a spend gate', () => {
    const r = run([line('g', GIFT, 50)], {
      ...baseConfig,
      trigger_type: 'buy_x_get_y',
      thresholds: {},
    });
    expect(discounted(r)).toHaveLength(1);
  });
});
