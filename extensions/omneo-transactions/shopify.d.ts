import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/OmneoTransactions.tsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-index.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
