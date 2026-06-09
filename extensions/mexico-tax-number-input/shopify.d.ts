import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Checkout.jsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.delivery-address.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}
