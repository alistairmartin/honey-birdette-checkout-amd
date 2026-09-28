import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/OrderStatusBlock.tsx' {
  const shopify:
    | import('@shopify/ui-extensions/customer-account.profile.block.render').Api
    | import('@shopify/ui-extensions/customer-account.order-status.block.render').Api
    | import('@shopify/ui-extensions/customer-account.order-index.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
