import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { readLoyaltyMessages, writeLoyaltyMessages } from "../lib/loyaltyMessages.server";
import { normalizeMessage, validateMessages } from "../lib/loyaltyMessages.shared";

// Banners at the top of the "The Honey Club" customer account page
// (extensions/honey-club-page). Saved to this store's
// $app:honey_club.loyalty_messages shop metafield; the page reads them through
// /api/loyalty-messages, so changes show without a deploy.

const TONE_OPTIONS = [
  { label: "Info (grey)", value: "info" },
  { label: "Success (green)", value: "success" },
  { label: "Warning (yellow)", value: "warning" },
  { label: "Critical (red)", value: "critical" },
];

const AUDIENCE_OPTIONS = [
  { label: "Everyone", value: "all" },
  { label: "Members only", value: "members" },
  { label: "Non-members only", value: "nonMembers" },
];

// Offered on a store with no messages yet: the advent offer the page used to
// hardcode, so a first-time setup is one Save away.
const STARTER_MESSAGE = {
  heading: "",
  text: "Members save on the Hot Night In Advent Calendar when they pre-order by 5 November. Terms apply.",
  linkLabel: "Find out more",
  linkUrl: "/pages/the-honey-club",
  tone: "info",
  audience: "all",
  startsOn: "",
  endsOn: "2026-11-05",
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { messages } = await readLoyaltyMessages(admin);
  return json({ shop: session.shop, messages });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  let raw;
  try {
    raw = JSON.parse(String(formData.get("messages") || "[]"));
  } catch (_e) {
    return json({ ok: false, error: "Couldn't read the messages." }, { status: 400 });
  }
  const messages = (Array.isArray(raw) ? raw : []).map(normalizeMessage);

  const errors = validateMessages(messages);
  if (errors.length) return json({ ok: false, error: errors.join(" ") }, { status: 400 });

  const { shopId } = await readLoyaltyMessages(admin);
  if (!shopId) return json({ ok: false, error: "Couldn't load the shop id." }, { status: 500 });

  const userErrors = await writeLoyaltyMessages(admin, shopId, messages);
  if (userErrors.length) return json({ ok: false, error: userErrors.join("; ") }, { status: 400 });

  return json({ ok: true, messages });
};

// Where a message stands today, for the badge on each card.
function scheduleStatus(message) {
  const today = new Date().toISOString().slice(0, 10);
  if (message.startsOn && today < message.startsOn) return { tone: "info", label: "Scheduled" };
  if (message.endsOn && today > message.endsOn) return { tone: undefined, label: "Ended" };
  return { tone: "success", label: "Live" };
}

export default function LoyaltyMessagingPage() {
  const { shop, messages: savedMessages } = useLoaderData();
  const fetcher = useFetcher();
  const saving = fetcher.state !== "idle";
  const result = fetcher.data;

  const [messages, setMessages] = useState(() =>
    savedMessages.length ? savedMessages : [normalizeMessage(STARTER_MESSAGE)],
  );
  const [saved, setSaved] = useState(savedMessages);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (result?.ok && result.messages) {
      setShowSaved(true);
      setMessages(result.messages);
      setSaved(result.messages);
    }
  }, [result]);

  const dirty = JSON.stringify(messages) !== JSON.stringify(saved);

  function update(index, key, value) {
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
  }
  function remove(index) {
    setMessages((prev) => prev.filter((_, i) => i !== index));
  }
  function move(index, delta) {
    setMessages((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });
  }
  function add() {
    setMessages((prev) => [...prev, normalizeMessage({}, prev.length)]);
  }
  function save() {
    fetcher.submit({ messages: JSON.stringify(messages) }, { method: "post" });
  }

  return (
    <Page>
      <TitleBar title="Loyalty messaging" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  Banners shown at the top of <b>The Honey Club</b> page in customer accounts on {shop},
                  in the order listed. Changes show as soon as you save, no deploy needed. Each store has
                  its own messages.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Dates are inclusive and use the customer's local time. Links can be a storefront path
                  (like /pages/the-honey-club, which opens on this store's site) or a full https:// URL.
                </Text>
              </BlockStack>
            </Card>

            {!savedMessages.length && !result?.ok ? (
              <Banner tone="info">
                No messages saved on this store yet. The advent offer below is prefilled: edit it or
                remove it, then Save.
              </Banner>
            ) : null}
            {result && !result.ok ? <Banner tone="critical">{result.error}</Banner> : null}
            {showSaved && !saving ? (
              <Banner tone="success" onDismiss={() => setShowSaved(false)}>
                Saved. The Honey Club page shows the new messages on next load.
              </Banner>
            ) : null}

            {messages.map((message, index) => {
              const status = scheduleStatus(message);
              return (
                <Card key={message.id}>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h2" variant="headingMd">
                          Message {index + 1}
                        </Text>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Button disabled={index === 0} onClick={() => move(index, -1)}>
                          Move up
                        </Button>
                        <Button disabled={index === messages.length - 1} onClick={() => move(index, 1)}>
                          Move down
                        </Button>
                        <Button tone="critical" onClick={() => remove(index)}>
                          Remove
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    <TextField
                      label="Heading"
                      value={message.heading}
                      onChange={(v) => update(index, "heading", v)}
                      autoComplete="off"
                      helpText="Optional bold title above the text."
                    />
                    <TextField
                      label="Text"
                      value={message.text}
                      onChange={(v) => update(index, "text", v)}
                      autoComplete="off"
                      multiline={2}
                      requiredIndicator
                    />
                    <InlineGrid columns={2} gap="400">
                      <TextField
                        label="Link text"
                        value={message.linkLabel}
                        onChange={(v) => update(index, "linkLabel", v)}
                        autoComplete="off"
                        placeholder="Find out more"
                      />
                      <TextField
                        label="Link URL"
                        value={message.linkUrl}
                        onChange={(v) => update(index, "linkUrl", v)}
                        autoComplete="off"
                        placeholder="/pages/the-honey-club"
                      />
                    </InlineGrid>
                    <InlineGrid columns={2} gap="400">
                      <Select
                        label="Style"
                        options={TONE_OPTIONS}
                        value={message.tone}
                        onChange={(v) => update(index, "tone", v)}
                      />
                      <Select
                        label="Show to"
                        options={AUDIENCE_OPTIONS}
                        value={message.audience}
                        onChange={(v) => update(index, "audience", v)}
                      />
                    </InlineGrid>
                    <InlineGrid columns={2} gap="400">
                      <TextField
                        label="Start date"
                        type="date"
                        value={message.startsOn}
                        onChange={(v) => update(index, "startsOn", v)}
                        autoComplete="off"
                        helpText="Blank = show now."
                      />
                      <TextField
                        label="End date"
                        type="date"
                        value={message.endsOn}
                        onChange={(v) => update(index, "endsOn", v)}
                        autoComplete="off"
                        helpText="Blank = no end. Hidden after this day."
                      />
                    </InlineGrid>
                  </BlockStack>
                </Card>
              );
            })}

            <InlineStack gap="200">
              <Button onClick={add}>Add message</Button>
              <Button variant="primary" onClick={save} loading={saving} disabled={!dirty && savedMessages.length > 0}>
                Save
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
