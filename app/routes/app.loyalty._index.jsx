import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// /app/loyalty opens on the first tab.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  return redirect(`/app/loyalty/messaging${url.search}`);
};
