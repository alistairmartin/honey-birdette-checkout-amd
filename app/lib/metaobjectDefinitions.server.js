// Scalable registry of metaobject definitions this app can provision into any
// store/region. The Metaobject Creator page (app.metaobject-creator.jsx) reads
// this registry to show one card + button per definition.
//
// To add a NEW metaobject in the future: append one entry to
// METAOBJECT_DEFINITIONS below. That's it - the UI, status checks and the
// create logic all pick it up automatically.
//
// A field that points at another definition uses `references: "<type>"`. The
// referenced definition's id is required by Shopify as a validation on the
// field, so it must exist first. provisionDefinitions() handles this for you by
// resolving dependencies and creating referenced definitions before the ones
// that point at them - list order in the registry does not matter.

import { adminGraphql } from "./adminGraphql.server";

export const METAOBJECT_DEFINITIONS = [
  {
    type: "shipping_row",
    name: "Shipping Row",
    description: "A single row in a shipping rates table.",
    displayNameKey: "option",
    fields: [
      {
        key: "option",
        name: "Shipping option",
        type: "single_line_text_field",
        required: true,
      },
      {
        key: "delivery_time",
        name: "Estimated delivery time",
        type: "single_line_text_field",
      },
      {
        key: "cost",
        name: "Cost",
        type: "multi_line_text_field",
        description: "First line is shown bold; following lines are detail.",
      },
    ],
  },
  {
    type: "shipping_table",
    name: "Shipping Table",
    description: "A shipping rates table: heading, footnote and a list of rows.",
    displayNameKey: "heading",
    fields: [
      {
        key: "heading",
        name: "Heading",
        type: "single_line_text_field",
        required: true,
      },
      {
        key: "note",
        name: "Footnote",
        type: "multi_line_text_field",
        description: "Shown in italics below the table (e.g. the *estimated... note).",
      },
      {
        key: "rows",
        name: "Rows",
        type: "list.metaobject_reference",
        references: "shipping_row",
      },
    ],
  },
];

const DEFINITION_BY_TYPE_QUERY = `#graphql
  query DefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      type
      name
      fieldDefinitions { key }
    }
  }`;

const DEFINITION_CREATE = `#graphql
  mutation CreateMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type name }
      userErrors { field message code }
    }
  }`;

const specByType = Object.fromEntries(
  METAOBJECT_DEFINITIONS.map((spec) => [spec.type, spec]),
);

export async function getDefinitionByType(admin, type) {
  const body = await adminGraphql(admin, DEFINITION_BY_TYPE_QUERY, { type });

  return body?.data?.metaobjectDefinitionByType ?? null;
}

// Current status of every registered definition - drives the loader/UI.
export async function getDefinitionsStatus(admin) {
  const out = [];

  for (const spec of METAOBJECT_DEFINITIONS) {
    const existing = await getDefinitionByType(admin, spec.type);

    out.push({
      type: spec.type,
      name: spec.name,
      description: spec.description,
      fieldKeys: spec.fields.map((f) => f.key),
      references: spec.fields.filter((f) => f.references).map((f) => f.references),
      exists: Boolean(existing),
      id: existing?.id ?? null,
    });
  }

  return out;
}

function buildFieldDefinitions(spec, typeToId) {
  return spec.fields.map((f) => {
    const field = { key: f.key, name: f.name, type: f.type };

    if (f.description) {
      field.description = f.description;
    }

    if (f.required) {
      field.required = true;
    }

    const validations = [...(f.validations ?? [])];

    if (f.references) {
      const refId = typeToId[f.references];

      if (!refId) {
        throw new Error(
          `Field "${f.key}" references "${f.references}" which hasn't been created yet.`,
        );
      }

      validations.push({ name: "metaobject_definition_id", value: refId });
    }

    if (validations.length) {
      field.validations = validations;
    }

    return field;
  });
}

async function createOneDefinition(admin, spec, typeToId) {
  const definition = {
    type: spec.type,
    name: spec.name,
    access: { storefront: "PUBLIC_READ" },
    fieldDefinitions: buildFieldDefinitions(spec, typeToId),
  };

  if (spec.description) {
    definition.description = spec.description;
  }

  if (spec.displayNameKey) {
    definition.displayNameKey = spec.displayNameKey;
  }

  const body = await adminGraphql(admin, DEFINITION_CREATE, { definition });
  const result = body?.data?.metaobjectDefinitionCreate;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length) {
    const msg = userErrors
      .map((e) => `${(e.field || []).join(".") || "definition"}: ${e.message}`)
      .join("; ");

    throw new Error(msg);
  }

  return result.metaobjectDefinition;
}

// Topological order: a definition's referenced types come before it.
function resolveOrder(targetTypes) {
  const order = [];
  const seen = new Set();

  const visit = (type) => {
    if (seen.has(type)) {
      return;
    }

    const spec = specByType[type];

    if (!spec) {
      throw new Error(`Unknown metaobject type: ${type}`);
    }

    for (const f of spec.fields) {
      if (f.references) {
        visit(f.references);
      }
    }

    seen.add(type);
    order.push(spec);
  };

  targetTypes.forEach(visit);

  return order;
}

// Provision the given types (and any types they reference). Existing
// definitions are left untouched and reported as "exists". Pass every
// registered type to create them all.
export async function provisionDefinitions(admin, targetTypes) {
  const specs = resolveOrder(targetTypes);
  const typeToId = {};
  const results = [];

  for (const spec of specs) {
    const existing = await getDefinitionByType(admin, spec.type);

    if (existing) {
      typeToId[spec.type] = existing.id;
      results.push({ type: spec.type, status: "exists", id: existing.id });
      continue;
    }

    const created = await createOneDefinition(admin, spec, typeToId);
    typeToId[spec.type] = created.id;
    results.push({ type: spec.type, status: "created", id: created.id });
  }

  return results;
}

export const ALL_TYPES = METAOBJECT_DEFINITIONS.map((s) => s.type);
