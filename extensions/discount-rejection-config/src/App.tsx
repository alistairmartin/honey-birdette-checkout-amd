import { useState } from "react";
import {
  useApi,
  AdminBlock,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Text,
  Divider,
  Badge,
  Banner,
} from "@shopify/ui-extensions-react/admin";

const CREATE_TARGET = "admin.discounts.create.render";
const DETAILS_TARGET = "admin.discounts.details.render";

const METAFIELD_NAMESPACE = "discount-rejection";
const METAFIELD_KEY = "config";

// Must match the tags hardcoded in the function's hasTags query.
// Adding tags outside this list requires updating the query and redeploying the function.
const SUPPORTED_TAGS = [
  "stop-discount-code",
  "no-discount",
  "blocked",
  "no-promo",
  "exclude-discount",
  "no-code",
  "restricted",
  "stop-promo",
  "no-discount-codes",
  "promo-excluded",
];

const DEFAULT_TAGS = ["stop-discount-code"];
const DEFAULT_MESSAGE = "Discount codes cannot be applied to this order.";

type Target = typeof CREATE_TARGET | typeof DETAILS_TARGET;

function readExistingConfig(api: ReturnType<typeof useApi<Target>>) {
  const metafields = (api as any).data?.metafields as
    | Array<{namespace: string; key: string; value: string}>
    | undefined;
  const existing = metafields?.find(
    (m) => m.namespace === METAFIELD_NAMESPACE && m.key === METAFIELD_KEY,
  );
  if (!existing?.value) return null;
  try {
    return JSON.parse(existing.value) as {tags?: string[]; message?: string};
  } catch {
    return null;
  }
}

export function App({target}: {target: Target}) {
  const api = useApi(target);
  const savedConfig = readExistingConfig(api);

  const [tags, setTags] = useState<string[]>(
    savedConfig?.tags?.length ? savedConfig.tags : DEFAULT_TAGS,
  );
  const [message, setMessage] = useState<string>(
    savedConfig?.message ?? DEFAULT_MESSAGE,
  );
  const [tagInput, setTagInput] = useState("");

  function persist(newTags: string[], newMessage: string) {
    (api as any).applyMetafieldsChange({
      type: "updateMetafield",
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      valueType: "json",
      value: JSON.stringify({tags: newTags, message: newMessage}),
    });
  }

  function addTag() {
    const trimmed = tagInput.trim().toLowerCase().replace(/\s+/g, "-");
    if (!trimmed || tags.includes(trimmed)) {
      setTagInput("");
      return;
    }
    const newTags = [...tags, trimmed];
    setTags(newTags);
    persist(newTags, message);
    setTagInput("");
  }

  function removeTag(tagToRemove: string) {
    const newTags = tags.filter((t) => t !== tagToRemove);
    setTags(newTags);
    persist(newTags, message);
  }

  function handleMessageChange(newMessage: string) {
    setMessage(newMessage);
    persist(tags, newMessage);
  }

  const unsupportedTags = tags.filter((t) => !SUPPORTED_TAGS.includes(t));

  return (
    <AdminBlock title="Discount Code Rejection">
      <BlockStack gap="base">
        <TextField
          label="Rejection Message"
          value={message}
          onChange={handleMessageChange}
          helpText="Shown to customers when their discount code is rejected."
          multiline={3}
        />
        <Divider />
        <BlockStack gap="extraSmall">
          <Text fontWeight="semibold">Blocked Product Tags</Text>
          <Text tone="subdued">
            Reject discount codes when the cart contains a product tagged with
            any of these.
          </Text>
          {tags.length > 0 && (
            <InlineStack gap="extraSmall" blockAlignment="center" wrap="wrap">
              {tags.map((tag) => (
                <InlineStack key={tag} gap="none" blockAlignment="center">
                  <Badge tone="info">{tag}</Badge>
                  <Button
                    variant="plain"
                    tone="critical"
                    onPress={() => removeTag(tag)}
                  >
                    ✕
                  </Button>
                </InlineStack>
              ))}
            </InlineStack>
          )}
          <InlineStack gap="small" blockAlignment="end">
            <TextField
              label="Add tag"
              labelHidden
              value={tagInput}
              onChange={setTagInput}
              placeholder="e.g. stop-discount-code"
            />
            <Button onPress={addTag}>Add</Button>
          </InlineStack>
          {unsupportedTags.length > 0 && (
            <Banner tone="caution">
              These tags require a function redeployment to take effect:{" "}
              {unsupportedTags.join(", ")}
            </Banner>
          )}
        </BlockStack>
      </BlockStack>
    </AdminBlock>
  );
}
