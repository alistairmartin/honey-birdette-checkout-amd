// Upload endpoint for the Asset uploader page (app/routes/app.asset-uploader.jsx).
//
// This is a resource route (no default export) so it always answers with JSON.
// The page can't use its own action for this: the upload is a three-step
// handshake (stage -> browser POSTs to Shopify -> create) and each step needs
// the previous step's response before it can start, so they go out as plain
// fetch() calls. A plain POST to a *page* route is a document request, and
// Remix answers it with the HTML page - which is why doing this on the page's
// action returned `Unexpected token '<', "<!DOCTYPE "...`.
//
// App Bridge patches window.fetch to attach the session token, so
// authenticate.admin resolves the shop the same way it would for a fetcher.

import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { MAX_FILES } from "../lib/assetNaming";
import { createFiles, stageUploads } from "../lib/assetUploader.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    if (intent === "stage") {
      const files = JSON.parse(form.get("files") || "[]");
      if (!files.length) {
        return json({ intent, error: "No files supplied." }, { status: 400 });
      }
      if (files.length > MAX_FILES) {
        return json(
          { intent, error: `Too many files. The limit is ${MAX_FILES} per batch.` },
          { status: 400 },
        );
      }
      return json({ intent, targets: await stageUploads(admin, files) });
    }

    if (intent === "create") {
      const files = JSON.parse(form.get("files") || "[]");
      return json({ intent, files: await createFiles(admin, files) });
    }

    return json({ intent, error: `Unknown intent: ${intent}` }, { status: 400 });
  } catch (error) {
    return json({ intent, error: error.message }, { status: 500 });
  }
};
