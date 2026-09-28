import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Checkout.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.delivery-address.render-before').Api;
  const globalThis: { shopify: typeof shopify };
}
