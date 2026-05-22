import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState } from "preact/hooks";

export default async () => {
  const existingDefinition = await getMetafieldDefinition();
  if (!existingDefinition) {
    // Create a metafield definition for persistence if no pre-existing definition exists
    const metafieldDefinition = await createMetafieldDefinition();

    if (!metafieldDefinition) {
      throw new Error("Failed to create metafield definition");
    }
  }

  const configuration = JSON.parse(
    shopify.data.validation?.metafields?.[0]?.value ?? "{}"
  );

  const products = await getProducts();

  render(
    <Extension configuration={configuration} products={products} />,
    document.body
  );
};

function Extension({ configuration, products }) {
  const [variantLimits, setVariantLimits] = useState(configuration);
  const [errors, setErrors] = useState([]);

  if (!products || products.length === 0) {
    return <s-text>No products found.</s-text>;
  }

  const shouldShowVariants = (variants) => {
    return (
      variants.length > 1 ||
      (variants.length === 1 && variants[0].title !== "Default Title")
    );
  };

  const applyMetafieldUpdate = async (limits) => {
    const result = await shopify.applyMetafieldChange({
      type: "updateMetafield",
      namespace: "$app:product-limits",
      key: "product-limits-values",
      value: JSON.stringify(limits),
    });

    if (result.type === "error") {
      setErrors([result.message]);
    }
  };

  const updateVariantLimit = async (variantId, value) => {
    setErrors([]);

    const newLimits = {
      ...variantLimits,
      [variantId]: value,
    };

    setVariantLimits(newLimits);

    await applyMetafieldUpdate(newLimits);
  };

  // Flatten products and variants for table display with better grouping
  const tableRows = products.flatMap((product) => {
    if (shouldShowVariants(product.variants)) {
      return product.variants.map((variant, index) => ({
        product,
        variant,
        isFirstVariant: index === 0,
        variantCount: product.variants.length,
      }));
    } else {
      return [
        {
          product,
          variant: { id: product.variants[0].id, title: "Default" },
          isFirstVariant: true,
          variantCount: 1,
        },
      ];
    }
  });

  return (
    <s-function-settings onSubmit={(event) => event.waitUntil(applyMetafieldUpdate(variantLimits))}>
      <ErrorBanner errors={errors} />
      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">Product</s-table-header>
          <s-table-header>Variant</s-table-header>
          <s-table-header>Limit</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {tableRows.map((row) => (
            <s-table-row key={`${row.product.title}-${row.variant.id}`}>
              <s-table-cell>
                {row.isFirstVariant && (
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-thumbnail
                      src={row.product.featuredImageUrl}
                      size="small"
                    />
                    <s-stack gap="none">
                      <s-text>{row.product.title}</s-text>
                      {row.variantCount > 1 && (
                        <s-text tone="neutral">
                          {row.variantCount} variants
                        </s-text>
                      )}
                    </s-stack>
                  </s-stack>
                )}
              </s-table-cell>
              <s-table-cell>
                <s-text>{row.variant.title}</s-text>
              </s-table-cell>
              <s-table-cell>
                <VariantNumberField
                  labelValue={`${row.product.title}, ${row.variant.title}`}
                  value={variantLimits[row.variant.id]}
                  name={row.variant.id}
                  onChange={(value) =>
                    updateVariantLimit(row.variant.id, value)
                  }
                />
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-function-settings>
  );
}

function ErrorBanner({ errors }) {
  if (errors.length === 0) return null;
  return (
    <s-stack gap="base">
      {errors.map((error, i) => (
        <s-banner key={i} heading="Error" tone="critical">
          {error}
        </s-banner>
      ))}
    </s-stack>
  );
}

function VariantNumberField({ labelValue, value, onChange, name }) {
  return (
    <s-number-field
      labelAccessibilityVisibility="exclusive"
      placeholder="Set limit"
      value={value || ""}
      name={`${name}-number`}
      label={`Set a limit for ${labelValue}`}
      min={0}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

async function getMetafieldDefinition() {
  const query = `#graphql
    query GetMetafieldDefinition {
      metafieldDefinitions(first: 1, ownerType: VALIDATION, namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
        nodes {
          id
        }
      }
    }
  `;

  const result = await shopify.query(query);

  return result?.data?.metafieldDefinitions?.nodes[0];
}

const METAFIELD_NAMESPACE = "$app:product-limits";
const METAFIELD_KEY = "product-limits-values";

async function createMetafieldDefinition() {
  const definition = {
    access: {
      admin: "MERCHANT_READ_WRITE",
    },
    key: METAFIELD_KEY,
    name: "Validation Configuration",
    namespace: METAFIELD_NAMESPACE,
    ownerType: "VALIDATION",
    type: "json",
  };

  const query = `#graphql
    mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition {
            id
          }
        }
      }
  `;

  const variables = { definition };
  const result = await shopify.query(query, { variables });

  return result?.data?.metafieldDefinitionCreate?.createdDefinition;
}

async function getProducts() {
  const query = `#graphql
  query FetchProducts {
    products(first: 8) {
      nodes {
        title
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        variants(first: 4) {
          nodes {
            id
            title
            image {
              url
            }
          }
        }
      }
    }
  }`;

  const result = await shopify.query(query);

  return result?.data?.products.nodes.map(
    ({ title, featuredMedia, variants }) => {
      return {
        title,
        featuredImageUrl: featuredMedia?.preview?.image.url,
        variants: variants.nodes.map((variant) => ({
          title: variant.title,
          id: variant.id,
          imageUrl: variant?.image?.url,
        })),
      };
    }
  );
}