import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/ValidationSettings.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.settings.validation.render').Api;
  const globalThis: { shopify: typeof shopify };
}
