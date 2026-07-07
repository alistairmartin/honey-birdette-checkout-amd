// Generic registry + install helpers for store-owned metafield definitions.
//
// Backs the "Metafield definitions" admin page (app/routes/app.metafield-definitions.jsx).
// To add more definitions later, describe a group and append it to GROUPS — the
// page renders and installs each group generically.
//
// A group descriptor is:
//   {
//     id, title, description,
//     ownerType,          // e.g. "CUSTOMER", "PRODUCT", "ORDER"
//     namespace,
//     definitions: [{ key, name, description, type, choices?, access? }]
//   }
// `choices` (optional) becomes a `choices` validation. `access` (optional)
// overrides the default { admin: MERCHANT_READ_WRITE, storefront: PUBLIC_READ }.

import { SIZE_PREFERENCE_GROUP } from "./sizePreferenceMetafields.server";

export const GROUPS = [SIZE_PREFERENCE_GROUP];

// Store-owned (non-`$app`) customer metafields that more than the defining app
// must write (app backend write route + CA account extension) require
// admin: PUBLIC_READ_WRITE. Shopify rejects MERCHANT_READ_WRITE here with
// "Setting this access control is not permitted. It must be one of [public_read_write]".
const DEFAULT_ACCESS = { admin: "PUBLIC_READ_WRITE", storefront: "PUBLIC_READ" };

function definitionsQuery(namespace, ownerType) {
  return `#graphql
    query DefinitionStatus {
      metafieldDefinitions(first: 100, ownerType: ${ownerType}, namespace: "${namespace}") {
        nodes { key }
      }
    }
  `;
}

const CREATE_MUTATION = `#graphql
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message code }
    }
  }
`;

function getGroup(id) {
  return GROUPS.find((g) => g.id === id) || null;
}

async function existingKeys(admin, group) {
  const resp = await admin.graphql(definitionsQuery(group.namespace, group.ownerType));
  const payload = await resp.json();
  return new Set((payload?.data?.metafieldDefinitions?.nodes ?? []).map((n) => n.key));
}

// Status of every registered group: which definitions already exist.
export async function getAllStatus(admin) {
  const groups = [];
  for (const group of GROUPS) {
    const keys = await existingKeys(admin, group);
    const definitions = group.definitions.map((d) => ({
      key: d.key,
      name: d.name,
      type: d.type,
      installed: keys.has(d.key),
    }));
    groups.push({
      id: group.id,
      title: group.title,
      description: group.description,
      ownerType: group.ownerType,
      namespace: group.namespace,
      definitions,
      installedCount: definitions.filter((d) => d.installed).length,
      total: definitions.length,
    });
  }
  return groups;
}

// Create any missing definitions in a group. Idempotent: a definition that
// already exists returns a TAKEN userError, treated as "already installed", so
// the button is safe to click repeatedly.
export async function installGroup(admin, id) {
  const group = getGroup(id);
  if (!group) {
    return { ok: false, error: `Unknown group: ${id}`, results: [] };
  }

  const results = [];
  for (const def of group.definitions) {
    const definition = {
      namespace: group.namespace,
      key: def.key,
      name: def.name,
      description: def.description,
      type: def.type,
      ownerType: group.ownerType,
      access: def.access || DEFAULT_ACCESS,
      ...(def.choices
        ? { validations: [{ name: "choices", value: JSON.stringify(def.choices) }] }
        : {}),
    };

    const resp = await admin.graphql(CREATE_MUTATION, { variables: { definition } });
    const payload = await resp.json();
    const data = payload?.data?.metafieldDefinitionCreate;
    const userErrors = data?.userErrors ?? [];
    const alreadyExists = userErrors.some((e) => e.code === "TAKEN");

    if (data?.createdDefinition) {
      results.push({ key: def.key, status: "created" });
    } else if (alreadyExists) {
      results.push({ key: def.key, status: "exists" });
    } else {
      results.push({
        key: def.key,
        status: "error",
        message: userErrors.map((e) => e.message).join(", ") || "Unknown error",
      });
    }
  }

  const failed = results.filter((r) => r.status === "error");
  return { ok: failed.length === 0, results };
}
