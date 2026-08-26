import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Announcement.jsx' {
  const shopify: import('@shopify/ui-extensions/purchase.thank-you.announcement.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/CustomerAccountAnnouncement.jsx' {
  const shopify:
    | import('@shopify/ui-extensions/customer-account.profile.announcement.render').Api
    | import('@shopify/ui-extensions/customer-account.order-index.announcement.render').Api
    | import('@shopify/ui-extensions/customer-account.order-status.announcement.render').Api;
  const globalThis: { shopify: typeof shopify };
}
