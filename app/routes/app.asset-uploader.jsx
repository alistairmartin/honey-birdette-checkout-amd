// Asset uploader - drop a batch of photos in, name them consistently, push
// them to Shopify Files in one go.
//
// The naming is the point: uploading 50 shots through the Shopify admin leaves
// you with IMG_4821.jpg fifty times. Here you set a prefix and a date once and
// every file lands as prefix-name-2026-07-20.jpg.
//
// Files go browser -> Shopify's signed staged-upload target directly, never
// through Render. See app/lib/assetUploader.server.js for why.

import { json } from "@remix-run/node";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DropZone,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { DeleteIcon, NoteIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { buildFilename, MAX_FILES } from "../lib/assetNaming";

// How many files go up the wire at once. Higher saturates a typical office
// connection and makes the per-file progress meaningless.
const UPLOAD_CONCURRENCY = 4;

// Resource route, not this page's action - see the comment at the top of it.
const UPLOAD_ENDPOINT = "/api/asset-upload";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return json({ maxFiles: MAX_FILES });
};

const todayStamp = () => new Date().toISOString().slice(0, 10);

const DATE_FORMATS = [
  { label: "2026-07-20", value: "iso" },
  { label: "20260720", value: "compact" },
  { label: "20-07-2026", value: "dmy" },
  { label: "Jul-2026", value: "monthYear" },
];

const formatDate = (isoDate, format) => {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  if (format === "compact") return `${y}${m}${d}`;
  if (format === "dmy") return `${d}-${m}-${y}`;
  if (format === "monthYear") {
    const month = new Date(`${isoDate}T00:00:00`).toLocaleString("en", {
      month: "short",
    });
    return `${month}-${y}`;
  }
  return isoDate;
};

const prettyBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function AssetUploader() {
  const [files, setFiles] = useState([]);
  const [prefix, setPrefix] = useState("");
  const [keepOriginalName, setKeepOriginalName] = useState(true);
  const [includeDate, setIncludeDate] = useState(true);
  const [dateValue, setDateValue] = useState(todayStamp);
  const [dateFormat, setDateFormat] = useState("iso");
  const [datePosition, setDatePosition] = useState("suffix");
  const [numberFiles, setNumberFiles] = useState(false);
  // Alt text applied to every file, and per-file overrides keyed by the File
  // object itself so reordering or renaming can't detach one from its file.
  const [defaultAlt, setDefaultAlt] = useState("");
  const [altOverrides, setAltOverrides] = useState(() => new Map());

  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  // Previews are object URLs; revoke them when the file leaves the list.
  const previewUrls = useRef(new Map());

  const dateStamp = includeDate ? formatDate(dateValue, dateFormat) : "";

  // The exact names that will be sent, in list order. Recomputed on every
  // settings change so the preview never drifts from what gets uploaded.
  const namedFiles = useMemo(
    () =>
      files.map((file, i) => ({
        file,
        filename: buildFilename({
          originalName: file.name,
          prefix,
          dateStamp,
          datePosition,
          keepOriginalName,
          index: numberFiles ? i + 1 : null,
        }),
        // An override wins even when it's blank - that's how you say "no alt
        // text on this one" while the rest of the batch shares the default.
        alt: (altOverrides.has(file) ? altOverrides.get(file) : defaultAlt).trim(),
      })),
    [
      files,
      prefix,
      dateStamp,
      datePosition,
      keepOriginalName,
      numberFiles,
      defaultAlt,
      altOverrides,
    ],
  );

  // Two files can easily collapse to the same name once you drop the original
  // and number nothing. Shopify would silently version them; better to say so.
  const duplicateNames = useMemo(() => {
    const seen = new Set();
    const dupes = new Set();
    for (const { filename } of namedFiles) {
      if (seen.has(filename)) dupes.add(filename);
      seen.add(filename);
    }
    return dupes;
  }, [namedFiles]);

  const missingAltCount = useMemo(
    () => namedFiles.filter(({ alt }) => !alt).length,
    [namedFiles],
  );

  const previewUrlFor = useCallback((file) => {
    if (!file.type.startsWith("image/")) return null;
    if (!previewUrls.current.has(file)) {
      previewUrls.current.set(file, URL.createObjectURL(file));
    }
    return previewUrls.current.get(file);
  }, []);

  const handleDrop = useCallback(
    (_dropFiles, acceptedFiles) => {
      setError(null);
      setResults(null);
      setFiles((current) => {
        const room = MAX_FILES - current.length;
        if (room <= 0) {
          setError(`You can upload ${MAX_FILES} files at a time.`);
          return current;
        }
        if (acceptedFiles.length > room) {
          setError(
            `Only the first ${room} of those were added - the limit is ${MAX_FILES} per batch.`,
          );
        }
        return [...current, ...acceptedFiles.slice(0, room)];
      });
    },
    [],
  );

  const setAltFor = useCallback((target, value) => {
    setAltOverrides((current) => new Map(current).set(target, value));
  }, []);

  const removeFile = useCallback((target) => {
    const url = previewUrls.current.get(target);
    if (url) {
      URL.revokeObjectURL(url);
      previewUrls.current.delete(target);
    }
    setFiles((current) => current.filter((file) => file !== target));
    setAltOverrides((current) => {
      if (!current.has(target)) return current;
      const next = new Map(current);
      next.delete(target);
      return next;
    });
  }, []);

  // Drops the queue and its object URLs. Kept separate from the banners so a
  // successful upload can empty the list without clearing its own result.
  const clearFiles = useCallback(() => {
    for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    setFiles([]);
    setAltOverrides(new Map());
  }, []);

  const clearAll = useCallback(() => {
    clearFiles();
    setResults(null);
    setError(null);
  }, [clearFiles]);

  // Posts one file to its signed target. Shopify requires the returned
  // parameters first and the file field last.
  const putToStagedTarget = async (target, file) => {
    const body = new FormData();
    for (const { name, value } of target.parameters) body.append(name, value);
    body.append("file", file);

    const response = await fetch(target.url, { method: "POST", body });
    if (!response.ok) {
      throw new Error(
        `Upload failed for ${file.name} (${response.status} ${response.statusText})`,
      );
    }
  };

  // Runs `worker` over items with a fixed number in flight. Sequential would
  // take minutes for 50 photos; unbounded stalls the browser's socket pool.
  const runPooled = async (items, worker) => {
    const queue = [...items.entries()];
    const runOne = async () => {
      while (queue.length) {
        const [index, item] = queue.shift();
        await worker(item, index);
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, runOne),
    );
  };

  // Plain fetch rather than useFetcher: this flow needs each step's response
  // before it can start the next, which a fetcher submit doesn't give you.
  const callAction = async (payload) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(payload)) body.append(key, value);
    const response = await fetch(UPLOAD_ENDPOINT, { method: "POST", body });

    // Never assume JSON: an auth redirect or a crash answers with HTML, and
    // response.json() would throw the useless "Unexpected token '<'".
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
  };

  const handleUpload = async () => {
    setError(null);
    setResults(null);
    setUploading(true);
    setProgress({ done: 0, total: namedFiles.length });

    try {
      const { targets } = await callAction({
        intent: "stage",
        files: JSON.stringify(
          namedFiles.map(({ file, filename }) => ({
            filename,
            mimeType: file.type || "application/octet-stream",
            fileSize: file.size,
          })),
        ),
      });

      await runPooled(namedFiles, ({ file }, index) =>
        putToStagedTarget(targets[index], file),
      );

      const { files: created } = await callAction({
        intent: "create",
        files: JSON.stringify(
          namedFiles.map(({ file, filename, alt }, index) => ({
            resourceUrl: targets[index].resourceUrl,
            filename,
            mimeType: file.type,
            alt,
          })),
        ),
      });

      setResults(created);
      clearFiles();
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setUploading(false);
    }
  };

  const canUpload = files.length > 0 && !uploading;

  return (
    <Page>
      <TitleBar title="Asset uploader" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && (
              <Banner tone="critical" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            )}

            {results && (
              <Banner tone="success" onDismiss={() => setResults(null)}>
                <BlockStack gap="200">
                  <Text as="p">
                    Uploaded {results.length}{" "}
                    {results.length === 1 ? "file" : "files"} to Shopify Files.
                    Shopify processes them in the background, so they may take a
                    moment to appear under Content &gt; Files.
                  </Text>
                </BlockStack>
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Naming
                </Text>

                <TextField
                  label="Prefix"
                  value={prefix}
                  onChange={setPrefix}
                  autoComplete="off"
                  placeholder="eg. summer-campaign"
                  helpText="Goes at the front of every filename. Spaces and symbols become hyphens."
                />

                <Checkbox
                  label="Keep the original filename"
                  checked={keepOriginalName}
                  onChange={setKeepOriginalName}
                  helpText="Turn this off if the camera names (IMG_4821) are noise."
                />

                <Checkbox
                  label="Add a date"
                  checked={includeDate}
                  onChange={setIncludeDate}
                />

                {includeDate && (
                  <InlineStack gap="400" align="start" blockAlign="end" wrap>
                    <Box minWidth="180px">
                      <TextField
                        label="Date"
                        type="date"
                        value={dateValue}
                        onChange={setDateValue}
                        autoComplete="off"
                      />
                    </Box>
                    <Box minWidth="180px">
                      <Select
                        label="Format"
                        options={DATE_FORMATS}
                        value={dateFormat}
                        onChange={setDateFormat}
                      />
                    </Box>
                    <Box minWidth="180px">
                      <Select
                        label="Position"
                        options={[
                          { label: "After the name", value: "suffix" },
                          { label: "Before the name", value: "prefix" },
                        ]}
                        value={datePosition}
                        onChange={setDatePosition}
                      />
                    </Box>
                  </InlineStack>
                )}

                <Checkbox
                  label="Number the files (01, 02, 03...)"
                  checked={numberFiles}
                  onChange={setNumberFiles}
                  helpText="Numbered in the order shown below."
                />

                <Box
                  background="bg-surface-secondary"
                  padding="300"
                  borderRadius="200"
                >
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Example
                    </Text>
                    <Text as="p" variant="bodyMd" fontWeight="medium">
                      {buildFilename({
                        originalName: files[0]?.name ?? "IMG_4821.jpg",
                        prefix,
                        dateStamp,
                        datePosition,
                        keepOriginalName,
                        index: numberFiles ? 1 : null,
                      })}
                    </Text>
                  </BlockStack>
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Alt text
                </Text>

                <TextField
                  label="Applies to every file"
                  value={defaultAlt}
                  onChange={setDefaultAlt}
                  autoComplete="off"
                  maxLength={512}
                  showCharacterCount
                  placeholder="eg. Model wearing the Golf Club set on a fairway"
                  helpText="Describe what's in the shot. Override any individual file below."
                />

                {missingAltCount > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {missingAltCount} of {files.length} will upload without alt
                    text. You can add it later under Content &gt; Files.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Files
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" tone="subdued" variant="bodySm">
                      {files.length} of {MAX_FILES}
                    </Text>
                    {files.length > 0 && (
                      <Button variant="plain" onClick={clearAll} disabled={uploading}>
                        Clear all
                      </Button>
                    )}
                  </InlineStack>
                </InlineStack>

                <DropZone onDrop={handleDrop} disabled={uploading}>
                  <DropZone.FileUpload
                    actionTitle="Add files"
                    actionHint={`Drop up to ${MAX_FILES} images or files here`}
                  />
                </DropZone>

                {duplicateNames.size > 0 && (
                  <Banner tone="warning">
                    {duplicateNames.size} filename
                    {duplicateNames.size === 1 ? "" : "s"} would repeat. Shopify
                    will version them (-1, -2). Turn on numbering or keep the
                    original names to avoid it.
                  </Banner>
                )}

                {namedFiles.length > 0 && (
                  <BlockStack gap="200">
                    {namedFiles.map(({ file, filename, alt }) => (
                      <Box
                        key={`${file.name}-${file.lastModified}-${file.size}`}
                        padding="200"
                        borderRadius="200"
                        background="bg-surface-secondary"
                      >
                        <BlockStack gap="200">
                          <InlineStack
                            gap="300"
                            blockAlign="center"
                            align="space-between"
                            wrap={false}
                          >
                            <InlineStack gap="300" blockAlign="center" wrap={false}>
                              <Thumbnail
                                size="small"
                                alt={alt || file.name}
                                source={previewUrlFor(file) || NoteIcon}
                              />
                              <BlockStack gap="050">
                                <Text as="span" variant="bodyMd" fontWeight="medium">
                                  {filename}
                                </Text>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {file.name} &middot; {prettyBytes(file.size)}
                                </Text>
                              </BlockStack>
                            </InlineStack>
                            <InlineStack gap="200" blockAlign="center">
                              {duplicateNames.has(filename) && (
                                <Badge tone="warning">Duplicate name</Badge>
                              )}
                              <Button
                                icon={DeleteIcon}
                                variant="tertiary"
                                accessibilityLabel={`Remove ${file.name}`}
                                onClick={() => removeFile(file)}
                                disabled={uploading}
                              />
                            </InlineStack>
                          </InlineStack>

                          <TextField
                            label={`Alt text for ${filename}`}
                            labelHidden
                            value={
                              altOverrides.has(file)
                                ? altOverrides.get(file)
                                : defaultAlt
                            }
                            onChange={(value) => setAltFor(file, value)}
                            autoComplete="off"
                            maxLength={512}
                            disabled={uploading}
                            placeholder="Alt text"
                          />
                        </BlockStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}

                {uploading && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Uploading {progress.done} of {progress.total}
                    </Text>
                    <ProgressBar
                      progress={
                        progress.total
                          ? (progress.done / progress.total) * 100
                          : 0
                      }
                      size="small"
                    />
                  </BlockStack>
                )}

                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={handleUpload}
                    loading={uploading}
                    disabled={!canUpload}
                  >
                    {files.length
                      ? `Upload ${files.length} ${files.length === 1 ? "file" : "files"}`
                      : "Upload"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
