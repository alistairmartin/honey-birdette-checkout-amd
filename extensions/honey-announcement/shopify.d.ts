import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/HoneyAnnouncement.tsx' {
  const shopify:
    | import('@shopify/ui-extensions/customer-account.profile.announcement.render').Api
    | import('@shopify/ui-extensions/customer-account.order-index.announcement.render').Api
    | import('@shopify/ui-extensions/customer-account.order-status.announcement.render').Api;
  const globalThis: { shopify: typeof shopify };
}
