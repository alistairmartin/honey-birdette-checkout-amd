import {json} from "@remix-run/node";
import {useLoaderData, useFetcher} from "@remix-run/react";
import {useState} from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import {TitleBar} from "@shopify/app-bridge-react";
import {authenticate} from "../shopify.server";
import {SUPPORTED_CURRENCIES, WEEK_COUNT} from "../lib/limitedOffer.shared";
import {
  activateWeek,
  getState,
  saveSchedule,
  setEnabled,
} from "../lib/limitedOffer.server";

export const loader = async ({request}) => {
  const {admin} = await authenticate.admin(request);
  try {
    const state = await getState(admin);
    return json({...state, loaderError: null});
  } catch (err) {
    return json({
      schedule: null,
      functionFound: false,
      loaderError: err?.message ?? String(err),
    });
  }
};

export const action = async ({request}) => {
  const {admin} = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "save") {
      const schedule = JSON.parse(formData.get("schedule"));
      const result = await saveSchedule(admin, schedule);
      return json({ok: true, intent, result});
    }
    if (intent === "activate") {
      const week = Number(formData.get("week"));
      const result = await activateWeek(admin, week);
      return json({ok: true, intent, result});
    }
    if (intent === "enable" || intent === "disable") {
      const result = await setEnabled(admin, intent === "enable");
      return json({ok: true, intent, result});
    }
    return json({ok: false, error: `Unknown intent: ${intent}`}, {status: 400});
  } catch (err) {
    return json({ok: false, intent, error: err?.message ?? String(err)}, {status: 500});
  }
};

export default function LimitedOfferPage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  const submittingIntent = fetcher.formData?.get("intent");
  const lastResult = fetcher.data;

  const initial = data.schedule;
  const [percentage, setPercentage] = useState(
    String(initial?.discountPercentage ?? 50),
  );
  const [thresholds, setThresholds] = useState(() =>
    SUPPORTED_CURRENCIES.reduce((acc, code) => {
      acc[code] = String(initial?.thresholds?.[code] ?? "");
      return acc;
    }, {}),
  );
  const [weeks, setWeeks] = useState(() =>
    Array.from({length: WEEK_COUNT}, (_, i) => {
      const w = initial?.weeks?.[i] ?? {};
      return {
        week: i + 1,
        productId: w.productId ?? "",
        title: w.title ?? "",
        note: w.note ?? "",
      };
    }),
  );

  const activeWeek = lastResult?.intent === "activate" && lastResult.ok
    ? lastResult.result.activeWeek
    : initial?.activeWeek ?? null;
  const enabled = initial?.enabled ?? true;

  const updateWeek = (idx, field, value) => {
    setWeeks((prev) =>
      prev.map((w, i) => (i === idx ? {...w, [field]: value} : w)),
    );
  };

  const submitSchedule = () => {
    const payload = {
      discountPercentage: Number(percentage) || 50,
      thresholds: SUPPORTED_CURRENCIES.reduce((acc, code) => {
        acc[code] = Number(thresholds[code]) || 0;
        return acc;
      }, {}),
      weeks,
    };
    fetcher.submit(
      {intent: "save", schedule: JSON.stringify(payload)},
      {method: "post"},
    );
  };

  const activate = (week) => {
    fetcher.submit({intent: "activate", week: String(week)}, {method: "post"});
  };

  return (
    <Page>
      <TitleBar title="Toy purchase-with-purchase" />
      <Layout>
        {data.loaderError ? (
          <Layout.Section>
            <Banner tone="critical" title="Could not load promo state">
              <Text as="pre" variant="bodySm">{data.loaderError}</Text>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Promo status</Text>
                {activeWeek ? (
                  enabled ? (
                    <Badge tone="success">{`Live - week ${activeWeek}`}</Badge>
                  ) : (
                    <Badge tone="warning">{`Paused (week ${activeWeek})`}</Badge>
                  )
                ) : (
                  <Badge tone="attention">No week activated</Badge>
                )}
                {data.functionFound ? (
                  <Badge tone="success">Function deployed</Badge>
                ) : (
                  <Badge tone="critical">Function not found</Badge>
                )}
              </InlineStack>

              <Text as="p" variant="bodyMd">
                Spend the per-currency threshold and get {percentage || 50}% off
                the active toy. The discount applies automatically in checkout;
                the checkout progress bar updates from the same config. Swap the
                toy each week by activating the next row below.
              </Text>

              {!data.functionFound ? (
                <Banner tone="warning">
                  The <code>toy-pwp-discount</code> function isn&apos;t deployed
                  to this store yet. Run <code>shopify app deploy</code>, then
                  reload before activating a week.
                </Banner>
              ) : null}

              {data.discountId ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  Discount: <code>{data.discountId}</code>
                  {data.discountStatus ? ` (${data.discountStatus})` : ""}
                </Text>
              ) : (
                <Text as="p" variant="bodySm" tone="subdued">
                  No automatic discount yet - it&apos;s created the first time
                  you activate a week.
                </Text>
              )}

              <InlineStack gap="200">
                <fetcher.Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value={enabled ? "disable" : "enable"}
                  />
                  <Button
                    submit
                    tone={enabled ? "critical" : undefined}
                    disabled={!activeWeek}
                    loading={
                      submitting &&
                      (submittingIntent === "enable" ||
                        submittingIntent === "disable")
                    }
                  >
                    {enabled ? "Pause promo" : "Resume promo"}
                  </Button>
                </fetcher.Form>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Global settings</Text>
              <InlineGrid columns={{xs: 1, sm: 2, md: 3}} gap="300">
                <TextField
                  label="Discount %"
                  type="number"
                  value={percentage}
                  onChange={setPercentage}
                  autoComplete="off"
                  suffix="%"
                />
                {SUPPORTED_CURRENCIES.map((code) => (
                  <TextField
                    key={code}
                    label={`Threshold ${code}`}
                    type="number"
                    value={thresholds[code]}
                    onChange={(v) =>
                      setThresholds((prev) => ({...prev, [code]: v}))
                    }
                    autoComplete="off"
                    prefix={code}
                  />
                ))}
              </InlineGrid>
              <Text as="p" variant="bodySm" tone="subdued">
                Each store only charges in its own currency, so only that row
                matters per store. The rest are kept so one config works
                everywhere.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Weekly toy schedule</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Paste the toy&apos;s product ID or admin URL for each week, Save,
                then click Activate when that week starts.
              </Text>

              {weeks.map((w, idx) => (
                <Box key={w.week}>
                  {idx > 0 ? <Box paddingBlockEnd="300"><Divider /></Box> : null}
                  <InlineGrid
                    columns={{xs: 1, md: "auto 1fr auto"}}
                    gap="300"
                    alignItems="end"
                  >
                    <Box minWidth="64px">
                      <BlockStack gap="100">
                        <Text as="span" variant="bodySm" tone="subdued">
                          Week
                        </Text>
                        <InlineStack gap="150" blockAlign="center">
                          <Text as="span" variant="headingLg">{w.week}</Text>
                          {activeWeek === w.week ? (
                            <Badge tone="success" size="small">Active</Badge>
                          ) : null}
                        </InlineStack>
                      </BlockStack>
                    </Box>
                    <TextField
                      label="Toy product ID / URL"
                      value={w.productId}
                      onChange={(v) => updateWeek(idx, "productId", v)}
                      autoComplete="off"
                      placeholder="e.g. 50277391"
                      helpText={w.title ? `Last resolved: ${w.title}` : undefined}
                    />
                    <Button
                      onClick={() => activate(w.week)}
                      disabled={!w.productId || !data.functionFound}
                      loading={
                        submitting &&
                        submittingIntent === "activate" &&
                        Number(fetcher.formData?.get("week")) === w.week
                      }
                      variant={activeWeek === w.week ? undefined : "primary"}
                    >
                      {activeWeek === w.week ? "Re-activate" : "Activate"}
                    </Button>
                  </InlineGrid>
                </Box>
              ))}

              <InlineStack gap="200">
                <Button
                  variant="primary"
                  onClick={submitSchedule}
                  loading={submitting && submittingIntent === "save"}
                >
                  Save schedule
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {lastResult ? (
          <Layout.Section>
            <Banner
              tone={lastResult.ok ? "success" : "critical"}
              title={lastResult.ok ? "Done" : "Action failed"}
            >
              <Box paddingBlockStart="200">
                <Text as="pre" variant="bodySm">
                  {JSON.stringify(lastResult, null, 2)}
                </Text>
              </Box>
            </Banner>
          </Layout.Section>
        ) : null}
      </Layout>
    </Page>
  );
}
