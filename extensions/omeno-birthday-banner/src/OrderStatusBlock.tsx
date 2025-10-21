import React, {useEffect, useMemo, useState} from "react";
import {
  Banner,
  BlockStack,
  Button,
  Form,
  Text,
  TextField,
  reactExtension,
  useMetafield,
} from "@shopify/ui-extensions-react/customer-account";

/**
 * Customer Account UI Extension – Customer Metafields editor
 * Reads & writes two customer metafields using an App Proxy endpoint:
 *  - custom.omeno_customer_birthday (DD/MM)
 *  - app.nickname (single_line_text_field)
 *
 * Server endpoint expected (Admin GraphQL under the hood):
 *   POST /apps/omeno-birthday/set
 *   body: { customerId, namespace, key, type, value }
 */

export default reactExtension(
  "customer-account.profile.block.render",
  () => <CustomerDetailsBlock />
);

const BDAY_NS = "custom";
const BDAY_KEY = "omeno_customer_birthday";
const NICK_NS = "app";
const NICK_KEY = "nickname";

function CustomerDetailsBlock() {
  // const customer = useCustomer();

  // Read current metafields
  const birthdayMf = useMetafield({
    namespace: BDAY_NS,
    key: BDAY_KEY,
    ownerType: "CUSTOMER",
  });
  const nicknameMf = useMetafield({
    namespace: NICK_NS,
    key: NICK_KEY,
    ownerType: "CUSTOMER",
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();
  const [debug, setDebug] = useState(false);

  const [birthday, setBirthday] = useState("");
  const [nickname, setNickname] = useState("");

  const bdayPattern = useMemo(
    () => /^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[0-2])$/, // DD/MM
    []
  );

  // Initialize inputs from metafields
  useEffect(() => {
    const b = (birthdayMf?.value as string | undefined) ?? "";
    const n = (nicknameMf?.value as string | undefined) ?? "";
    setBirthday(b);
    setNickname(n);
    setLoading(false);
  }, [birthdayMf?.value, nicknameMf?.value]);

  async function save() {
    setError(undefined);
    setSaved(undefined);

    // if (!customer?.id) {
    //   setError("Missing customer ID");
    //   return;
    // }

    const updates: Array<{
      namespace: string;
      key: string;
      type: string;
      value: string;
    }> = [];

    const bdayVal = birthday.trim();
    const nickVal = nickname.trim();

    // Validate and queue birthday if provided
    if (bdayVal) {
      if (!bdayPattern.test(bdayVal)) {
        setError("Birthday must be DD/MM (e.g. 12/04)");
        return;
      }
      updates.push({
        namespace: BDAY_NS,
        key: BDAY_KEY,
        type: "single_line_text_field",
        value: bdayVal,
      });
    } else {
      // Allow clearing the value by saving empty string
      updates.push({
        namespace: BDAY_NS,
        key: BDAY_KEY,
        type: "single_line_text_field",
        value: "",
      });
    }

    // Validate and queue nickname (optional, max ~50 chars by convention)
    if (nickVal.length > 50) {
      setError("Nickname is too long (max 50 characters)");
      return;
    }
    updates.push({
      namespace: NICK_NS,
      key: NICK_KEY,
      type: "single_line_text_field",
      value: nickVal,
    });

    setSaving(true);
    try {
      // Send sequentially to a simple proxy that accepts single metafield writes
      for (const u of updates) {
        const resp = await fetch("/apps/omeno-birthday/set", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // customerId: customer.id,
            namespace: u.namespace,
            key: u.key,
            type: u.type,
            value: u.value,
          }),
        });
        let result: any = undefined;
        try { result = await resp.json(); } catch {}

        if (!resp.ok) {
          const msg = (result && (result.error || result.message)) || `Save failed for ${u.namespace}.${u.key}`;
          setError(String(msg));
          return;
        }
        const userErrors = (result && (result.userErrors || result.errors)) || [];
        if (Array.isArray(userErrors) && userErrors.length) {
          setError(userErrors.map((e: any) => e.message || e).join(", "));
          return;
        }
      }

      setSaved("Saved.");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Something went wrong while saving");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Banner>
        <Text>Loading…</Text>
      </Banner>
    );
  }

  return (
    <Banner>
      <BlockStack spacing>
        <Text>Update your details below. We’ll use these to personalize your account experience.</Text>

        <Form onSubmit={save}>
          <BlockStack spacing>
            <TextField
              label="Preferred name (optional)"
              value={nickname}
              onChange={setNickname}
              maxLength={50}
              placeholder="e.g. Al"
            />

            <TextField
              label="Birthday (DD/MM)"
              value={birthday}
              onChange={(v) => setBirthday(v.replace(/[^0-9/]/g, "").slice(0, 5))}
              placeholder="12/04"
              inputMode="numeric"
              maxLength={5}
              helpText="We use this to send you a birthday surprise."
            />

            {error ? <Text appearance="critical">{error}</Text> : null}
            {saved ? <Text appearance="success">{saved}</Text> : null}

            <Button kind="primary" submitting={saving} disabled={saving}>
              Save details
            </Button>

            <Text appearance="subdued" size="small">
              <Button kind="secondary" onPress={() => setDebug((d) => !d)}>
                {debug ? "Hide" : "Show"} debug
              </Button>
            </Text>

            {debug ? (
              <BlockStack spacing="tight">
                {/* <Text size="small">customerId: {String(customer?.id || "—")}</Text> */}
                <Text size="small">birthdayMf: {String((birthdayMf?.value as string) ?? "—")}</Text>
                <Text size="small">nicknameMf: {String((nicknameMf?.value as string) ?? "—")}</Text>
              </BlockStack>
            ) : null}
          </BlockStack>
        </Form>
      </BlockStack>
    </Banner>
  );
}