import { useRef, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Link,
  Page,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listBannerStatus,
  applyEmailBannerEverywhere,
} from "../lib/emailBanner.server";

const LIQUID_SNIPPET = `{%- assign image_banner_url = shop.metafields.email.banner_url -%}`;

// Same resource route the Asset uploader uses (stage -> browser POST -> create),
// plus a poll intent because Shopify processes the file asynchronously and the
// CDN url doesn't exist until it's READY.
const UPLOAD_ENDPOINT = "/api/asset-upload";
const POLL_INTERVAL_MS = 1500;
const POLL_ATTEMPTS = 40;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const stores = await listBannerStatus();
  return json({ currentShop: session.shop, stores });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const url = String(formData.get("url") || "").trim();

  if (!/^https:\/\/.+/.test(url)) {
    return json(
      { ok: false, error: "Enter a full image URL starting with https://" },
      { status: 400 },
    );
  }

  try {
    const results = await applyEmailBannerEverywhere(url);
    return json({ ok: results.every((r) => r.ok), url, results });
  } catch (err) {
    return json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 2x the ~600px email body width; the CDN resizes on the fly.
const BANNER_WIDTH = 1200;

function withBannerWidth(cdnUrl) {
  try {
    const parsed = new URL(cdnUrl);
    parsed.searchParams.set("width", String(BANNER_WIDTH));
    return parsed.toString();
  } catch {
    return cdnUrl;
  }
}

function withoutBannerWidth(cdnUrl) {
  try {
    const parsed = new URL(cdnUrl);
    parsed.searchParams.delete("width");
    return parsed.toString();
  } catch {
    return cdnUrl;
  }
}

function hasBannerWidth(cdnUrl) {
  try {
    return new URL(cdnUrl).searchParams.has("width");
  } catch {
    return false;
  }
}

// Plain fetch rather than useFetcher: each step needs the previous step's
// response. Never assume JSON - an auth redirect answers with HTML.
async function callUploadEndpoint(payload) {
  const body = new FormData();
  for (const [key, value] of Object.entries(payload)) body.append(key, value);
  const response = await fetch(UPLOAD_ENDPOINT, { method: "POST", body });
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(
      response.ok
        ? "The server didn't return JSON. Reload the page and try again."
        : `Request failed (HTTP ${response.status})`,
    );
  }
  if (result.error) throw new Error(result.error);
  return result;
}

// Shopify requires the signed parameters first and the file field last.
async function putToStagedTarget(target, file) {
  const body = new FormData();
  for (const { name, value } of target.parameters) body.append(name, value);
  body.append("file", file);
  const response = await fetch(target.url, { method: "POST", body });
  if (!response.ok) {
    throw new Error(
      `Upload failed for ${file.name} (${response.status} ${response.statusText})`,
    );
  }
}

export default function EmailBannerPage() {
  const { currentShop, stores } = useLoaderData();
  const fetcher = useFetcher();
  const saving = fetcher.state !== "idle";
  const data = fetcher.data;

  const current = stores.find((s) => s.shop === currentShop);
  const [url, setUrl] = useState(current?.url || "");
  const previewUrl = /^https:\/\/.+/.test(url) ? url : "";

  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStep, setUploadStep] = useState("");
  const [uploadError, setUploadError] = useState(null);
  const [uploadedName, setUploadedName] = useState(null);

  const handleFilePicked = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setUploadError("Pick an image file (jpg, png, gif, webp).");
      return;
    }

    setUploading(true);
    setUploadError(null);
    setUploadedName(null);
    try {
      setUploadStep("Requesting upload target...");
      const { targets } = await callUploadEndpoint({
        intent: "stage",
        files: JSON.stringify([
          { filename: file.name, mimeType: file.type, fileSize: file.size },
        ]),
      });

      setUploadStep("Uploading to Shopify...");
      await putToStagedTarget(targets[0], file);

      setUploadStep("Creating file...");
      const { files: created } = await callUploadEndpoint({
        intent: "create",
        files: JSON.stringify([
          {
            resourceUrl: targets[0].resourceUrl,
            filename: file.name,
            mimeType: file.type,
            alt: "Email banner",
          },
        ]),
      });
      const fileId = created?.[0]?.id;
      if (!fileId) throw new Error("fileCreate returned no file id.");

      // The CDN url appears once Shopify finishes processing.
      setUploadStep("Waiting for Shopify to process the image...");
      let cdnUrl = created[0]?.image?.url || null;
      for (let attempt = 0; !cdnUrl && attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_INTERVAL_MS);
        const { file: status } = await callUploadEndpoint({
          intent: "poll",
          id: fileId,
        });
        if (status.status === "FAILED") {
          throw new Error("Shopify failed to process the image.");
        }
        cdnUrl = status.url;
      }
      if (!cdnUrl) {
        throw new Error(
          "Timed out waiting for the CDN URL. The file is in Content > Files - copy its URL from there.",
        );
      }

      setUrl(cdnUrl);
      setUploadedName(file.name);
    } catch (err) {
      setUploadError(err?.message ?? String(err));
    } finally {
      setUploading(false);
      setUploadStep("");
    }
  };

  return (
    <Page>
      <TitleBar title="Email banner" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Update email banner
              </Text>
              <Text as="p" variant="bodyMd">
                Upload the new campaign banner (or paste a CDN URL from Shopify
                Files). Saving writes the <code>email.banner_url</code> shop
                metafield on every store, so all notification email templates in
                all regions pick it up immediately. Upload a fresh file each
                week so email clients can&apos;t serve a cached copy of the old
                banner.
              </Text>

              {uploadError ? (
                <Banner tone="critical" onDismiss={() => setUploadError(null)}>
                  {uploadError}
                </Banner>
              ) : null}
              {uploadedName && !uploading ? (
                <Banner tone="success" onDismiss={() => setUploadedName(null)}>
                  Uploaded {uploadedName} to Shopify Files and filled in its CDN
                  URL below. Click Apply to all stores to publish it.
                </Banner>
              ) : null}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleFilePicked}
              />

              <fetcher.Form method="post">
                <BlockStack gap="300">
                  <TextField
                    label="Banner image URL"
                    name="url"
                    value={url}
                    onChange={setUrl}
                    autoComplete="off"
                    placeholder="https://cdn.shopify.com/s/files/.../email-banner.jpg?v=..."
                    helpText="Must be a full https:// URL. Optional: the resize button below appends width=1200 so Shopify serves a resized copy - 1200px is 2x the ~600px email body width, sharp on retina without bloating the email."
                    disabled={uploading}
                    connectedRight={
                      <Button
                        onClick={() => fileInputRef.current?.click()}
                        loading={uploading}
                        disabled={saving}
                      >
                        Upload image
                      </Button>
                    }
                  />
                  {uploading && uploadStep ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {uploadStep}
                    </Text>
                  ) : null}
                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      submit
                      loading={saving}
                      disabled={!url || uploading}
                    >
                      Apply to all stores
                    </Button>
                    {hasBannerWidth(url) ? (
                      <Button
                        onClick={() => setUrl(withoutBannerWidth(url))}
                        disabled={uploading || saving}
                      >
                        Remove width={BANNER_WIDTH} resize
                      </Button>
                    ) : (
                      <Button
                        onClick={() => setUrl(withBannerWidth(url))}
                        disabled={!previewUrl || uploading || saving}
                      >
                        Resize to {BANNER_WIDTH}px
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>
              </fetcher.Form>

              {previewUrl ? (
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Preview:
                  </Text>
                  <Box borderColor="border" borderWidth="025" borderRadius="200" padding="200">
                    <img
                      src={previewUrl}
                      alt="Email banner preview"
                      style={{ maxWidth: "100%", display: "block" }}
                    />
                  </Box>
                </BlockStack>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        {data && !data.ok && data.error ? (
          <Layout.Section>
            <Card>
              <Box padding="300" background="bg-surface-critical" borderRadius="200">
                <Text as="pre" variant="bodySm">
                  {data.error}
                </Text>
              </Box>
            </Card>
          </Layout.Section>
        ) : null}

        {data?.results ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    Save result
                  </Text>
                  {data.ok ? (
                    <Badge tone="success">All stores updated</Badge>
                  ) : (
                    <Badge tone="critical">Some stores failed</Badge>
                  )}
                </InlineStack>
                <BlockStack gap="100">
                  {data.results.map((r) => (
                    <InlineStack key={r.shop} gap="200" blockAlign="center">
                      {r.ok ? (
                        <Badge tone="success">Updated</Badge>
                      ) : (
                        <Badge tone="critical">Failed</Badge>
                      )}
                      <Text as="span" variant="bodySm">
                        {r.shop}
                        {r.error ? ` - ${r.error}` : ""}
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Current value per store
              </Text>
              <BlockStack gap="200">
                {stores.map((s) => (
                  <InlineStack key={s.shop} gap="200" blockAlign="center" wrap={false}>
                    {s.url ? (
                      <Thumbnail
                        size="small"
                        source={s.url}
                        alt={`Current banner on ${s.name || s.shop}`}
                      />
                    ) : null}
                    <Box minWidth="180px">
                      <Text as="span" variant="bodyMd">
                        {s.flag} {s.name || s.shop}
                      </Text>
                    </Box>
                    {s.region ? <Badge>{s.region}</Badge> : null}
                    {!s.reachable ? (
                      <Badge tone="critical">Unreachable</Badge>
                    ) : s.url ? (
                      <Link url={s.url} target="_blank">
                        <Text as="span" variant="bodySm" breakWord>
                          {s.url}
                        </Text>
                      </Link>
                    ) : (
                      <Badge tone="attention">Not set</Badge>
                    )}
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                One-time template change
              </Text>
              <Text as="p" variant="bodyMd">
                Replace the hardcoded assign at the top of each notification
                email template with:
              </Text>
              <Box
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
                overflowX="scroll"
              >
                <Text as="pre" variant="bodySm">
                  {LIQUID_SNIPPET}
                </Text>
              </Box>
              <Text as="p" variant="bodyMd">
                After that, templates never need editing for a campaign change.
                Only the metafield is updated from this page.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
