// Asset uploader - bulk uploads into Shopify Files (Content > Files).
//
// The upload happens in three hops, and the middle one deliberately skips this
// server: Render would have to hold 30 full-size photos in memory otherwise.
//
//   1. stageUploads()  - ask Shopify for one signed target per file
//   2. browser         - POSTs each file straight to that target (see the route)
//   3. createFiles()   - hand the resulting resourceUrls back to Shopify
//
// Shopify then processes the files asynchronously, so pollFiles() exists to
// turn UPLOADED into READY (or surface FAILED) once they settle.

export { buildFilename } from "./assetNaming";

// Which Shopify resource/content type a file belongs to. Getting this wrong is
// the usual cause of a staged upload that succeeds but never becomes a file.
export const classifyFile = (mimeType) => {
  const type = String(mimeType ?? "");
  if (type.startsWith("image/")) {
    return { resource: "IMAGE", contentType: "IMAGE" };
  }
  if (type.startsWith("video/")) {
    return { resource: "VIDEO", contentType: "VIDEO" };
  }
  return { resource: "FILE", contentType: "FILE" };
};

const STAGED_UPLOADS_CREATE = `#graphql
  mutation AssetUploaderStage($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation AssetUploaderCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        alt
        ... on GenericFile { url originalFileSize }
        ... on MediaImage {
          image { url width height }
        }
        ... on Video {
          originalSource { url }
        }
      }
      userErrors { field message }
    }
  }
`;

const FILES_STATUS = `#graphql
  query AssetUploaderStatus($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on GenericFile { id fileStatus url fileErrors { code details } }
      ... on MediaImage {
        id
        fileStatus
        fileErrors { code details }
        image { url width height }
      }
      ... on Video { id fileStatus fileErrors { code details } }
    }
  }
`;

const throwOnUserErrors = (userErrors, label) => {
  if (userErrors?.length) {
    throw new Error(
      `${label}: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
};

/**
 * Asks Shopify for one signed upload target per file.
 * @param files [{ filename, mimeType, fileSize }] - fileSize as a string of bytes
 */
export async function stageUploads(admin, files) {
  const input = files.map((file) => ({
    filename: file.filename,
    mimeType: file.mimeType || "application/octet-stream",
    fileSize: String(file.fileSize),
    httpMethod: "POST",
    resource: classifyFile(file.mimeType).resource,
  }));

  const response = await admin.graphql(STAGED_UPLOADS_CREATE, {
    variables: { input },
  });
  const body = await response.json();
  const result = body?.data?.stagedUploadsCreate;
  throwOnUserErrors(result?.userErrors, "stagedUploadsCreate");

  // Targets come back in request order, so zip them back onto the originals.
  return (result?.stagedTargets ?? []).map((target, i) => ({
    ...target,
    filename: files[i].filename,
    mimeType: files[i].mimeType,
  }));
}

/**
 * Turns uploaded staged resources into real Shopify files.
 * @param files [{ resourceUrl, filename, mimeType, alt }]
 */
export async function createFiles(admin, files) {
  const response = await admin.graphql(FILE_CREATE, {
    variables: {
      files: files.map((file) => ({
        originalSource: file.resourceUrl,
        filename: file.filename,
        contentType: classifyFile(file.mimeType).contentType,
        alt: file.alt || "",
      })),
    },
  });
  const body = await response.json();
  const result = body?.data?.fileCreate;
  throwOnUserErrors(result?.userErrors, "fileCreate");
  return result?.files ?? [];
}

/** Re-reads file status after Shopify's async processing. */
export async function pollFiles(admin, ids) {
  if (!ids?.length) return [];
  const response = await admin.graphql(FILES_STATUS, { variables: { ids } });
  const body = await response.json();
  return (body?.data?.nodes ?? []).filter(Boolean);
}
