// Copy endpoint for the Template copier page (app/routes/app.template-copier.jsx).
//
// This is a resource route (no default export) so it always answers with JSON.
// The page can't use its own action for this: the copy fans out to one request
// per destination store so each region can report its own progress, and those go
// out as plain fetch() calls. A plain POST to a *page* route is a document
// request, and Remix answers it with the HTML page - which is why doing this on
// the page's action returned `Unexpected token '<', "<!DOCTYPE "...`.
//
// App Bridge patches window.fetch to attach the session token, so
// authenticate.admin resolves the shop the same way it would for a fetcher.

import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  copyToTarget,
  listThemes,
  readFiles,
  recentCopies,
  resolveActor,
} from "../lib/themeCopier.server";

export const action = async ({ request }) => {
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const sourceShop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    // Cheap enough to re-fetch once the fan-out finishes, rather than having
    // every in-flight copy request compute its own stale copy of it.
    if (intent === "history") {
      return json({ intent, history: await recentCopies(sourceShop) });
    }

    if (intent !== "copy") {
      return json({ intent, error: `Unknown intent: ${intent}` }, { status: 400 });
    }

    const sourceThemeId = String(formData.get("sourceThemeId"));
    const filenames = JSON.parse(String(formData.get("filenames") || "[]"));
    const target = JSON.parse(String(formData.get("target") || "null"));
    const copyMediaEnabled = formData.get("copyMedia") === "true";
    const overwriteExistingMedia = formData.get("overwriteMedia") === "true";
    // Minted by the browser, shared by every region in this press of the button,
    // so the history can group the per-store rows back into one event.
    const batchId = String(formData.get("batchId") || "");

    if (filenames.length === 0) {
      return json({ intent, error: "Select at least one template to copy." }, { status: 400 });
    }
    if (!target?.shop || !target?.themeId) {
      return json({ intent, error: "No destination store or theme." }, { status: 400 });
    }
    // Copying a theme onto itself is a no-op that would still snapshot and
    // "overwrite" its own files. The UI hides this option; guard it anyway.
    if (target.shop === sourceShop && target.themeId === sourceThemeId) {
      return json(
        { intent, error: "Source and destination theme are the same." },
        { status: 400 },
      );
    }

    const themes = await listThemes(admin);
    const sourceTheme = themes.find((t) => t.id === sourceThemeId);
    if (!sourceTheme) {
      return json({ intent, error: "That source theme no longer exists." }, { status: 400 });
    }

    const sourceFiles = await readFiles(admin, sourceThemeId, filenames);

    // The acting staff member, resolved from the session token's `sub`. Recorded
    // on the copy so the history says who to ask if a template ends up wrong.
    const copiedBy = await resolveActor(admin, sessionToken?.sub);

    // copyToTarget resolves rather than throws, so a dead store reports its own
    // failure in the result instead of 500ing this request.
    const result = await copyToTarget({
      batchId,
      sourceShop,
      sourceAdmin: admin,
      sourceTheme,
      sourceFiles,
      targetShop: target.shop,
      targetThemeId: target.themeId,
      copyMediaEnabled,
      overwriteExistingMedia,
      copiedBy,
    });

    return json({ intent, result });
  } catch (err) {
    return json({ intent, error: err?.message ?? String(err) }, { status: 500 });
  }
};
