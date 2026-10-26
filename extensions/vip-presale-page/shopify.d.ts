import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/VipPresalePage.tsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.page.render').Api;
  const globalThis: { shopify: typeof shopify };
}
