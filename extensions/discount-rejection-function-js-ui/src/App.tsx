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

const DEFAULT_MESSAGE = "Sorry Honey, discounts codes not allowed on Sale, Gift Cards or Swimwear items.";
const DEFAULT_RULES = [{ tag: "stop-discount-code", message: DEFAULT_MESSAGE }];

type Rule = { tag: string; message: string };
type Target = typeof CREATE_TARGET | typeof DETAILS_TARGET;

function readExistingRules(api: ReturnType<typeof useApi<Target>>): Rule[] {
  const metafields = (api as any).data?.metafields as
    | Array<{ namespace: string; key: string; value: string }>
    | undefined;
  const existing = metafields?.find(
    (m) => m.namespace === METAFIELD_NAMESPACE && m.key === METAFIELD_KEY,
  );
  if (!existing?.value) return DEFAULT_RULES;
  try {
    const parsed = JSON.parse(existing.value);
    // Support new rules format
    if (Array.isArray(parsed.rules) && parsed.rules.length > 0) {
      return parsed.rules;
    }
    // Migrate old {tags, message} format
    if (Array.isArray(parsed.tags) && parsed.tags.length > 0) {
      return parsed.tags.map((tag: string) => ({
        tag,
        message: parsed.message ?? DEFAULT_MESSAGE,
      }));
    }
  } catch {}
  return DEFAULT_RULES;
}

export function App({ target }: { target: Target }) {
  const api = useApi(target);
  const [rules, setRules] = useState<Rule[]>(readExistingRules(api));
  const [tagInput, setTagInput] = useState("");
  const [messageInput, setMessageInput] = useState(DEFAULT_MESSAGE);

  function persist(newRules: Rule[]) {
    (api as any).applyMetafieldsChange({
      type: "updateMetafield",
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      valueType: "json",
      value: JSON.stringify({ rules: newRules }),
    });
  }

  function addRule() {
    const tag = tagInput.trim().toLowerCase().replace(/\s+/g, "-");
    const message = messageInput.trim();
    if (!tag || !message || rules.some((r) => r.tag === tag)) {
      setTagInput("");
      return;
    }
    const newRules = [...rules, { tag, message }];
    setRules(newRules);
    persist(newRules);
    setTagInput("");
    setMessageInput(DEFAULT_MESSAGE);
  }

  function removeRule(tag: string) {
    const newRules = rules.filter((r) => r.tag !== tag);
    setRules(newRules);
    persist(newRules);
  }

  const unsupportedTags = rules
    .map((r) => r.tag)
    .filter((t) => !SUPPORTED_TAGS.includes(t));

  return (
    <AdminBlock title="Discount Code Rejection">
      <BlockStack gap="base">
        <BlockStack gap="extraSmall">
          <Text fontWeight="semibold">Rejection Rules</Text>
          <Text tone="subdued">
            Each rule defines a product tag and the message shown when a
            discount code is rejected for that tag.
          </Text>
        </BlockStack>

        {rules.length > 0 && (
          <BlockStack gap="extraSmall">
            {rules.map((rule) => (
              <InlineStack key={rule.tag} gap="small" blockAlignment="center">
                <Badge tone="info">{rule.tag}</Badge>
                <Text>{rule.message}</Text>
                <Button
                  variant="plain"
                  tone="critical"
                  onPress={() => removeRule(rule.tag)}
                >
                  Remove
                </Button>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        <Divider />

        <BlockStack gap="small">
          <Text fontWeight="semibold">Add Rule</Text>
          <TextField
            label="Product Tag"
            value={tagInput}
            onChange={setTagInput}
            placeholder="e.g. stop-discount-code"
            helpText={`Supported tags: ${SUPPORTED_TAGS.join(", ")}`}
          />
          <TextField
            label="Rejection Message"
            value={messageInput}
            onChange={setMessageInput}
            placeholder={DEFAULT_MESSAGE}
            multiline={2}
          />
          <Button onPress={addRule}>Add Rule</Button>
        </BlockStack>

        {unsupportedTags.length > 0 && (
          <Banner tone="caution">
            These tags require a function redeployment to take effect:{" "}
            {unsupportedTags.join(", ")}
          </Banner>
        )}
      </BlockStack>
    </AdminBlock>
  );
}
