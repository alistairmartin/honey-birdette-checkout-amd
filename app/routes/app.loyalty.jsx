import { Outlet, useLocation, useNavigate } from "@remix-run/react";
import { Box, Card, Tabs } from "@shopify/polaris";

// "Loyalty" section of the app admin: one nav entry, with a tab per tool.
// Each tab is its own child route (app.loyalty.<tab>.jsx) rendering its own Page.

const TABS = [
  { id: "messaging", content: "Loyalty messaging", path: "/app/loyalty/messaging" },
  { id: "exclusives", content: "Loyalty exclusives", path: "/app/loyalty/exclusives" },
  { id: "tier-sync", content: "Tier sync", path: "/app/loyalty/tier-sync" },
  { id: "order-tags", content: "Order tags", path: "/app/loyalty/order-tags" },
];

export default function LoyaltyLayout() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const selected = Math.max(
    0,
    TABS.findIndex((tab) => pathname.startsWith(tab.path)),
  );

  return (
    <>
      <Box paddingInline="400" paddingBlockStart="400">
        <div style={{ maxWidth: "998px", margin: "0 auto" }}>
          <Card padding="0">
            <Tabs
              tabs={TABS.map(({ id, content }) => ({ id, content, panelID: `${id}-panel` }))}
              selected={selected}
              // Keep the embedded-app query string (host, shop) when switching tabs.
              onSelect={(index) => navigate(`${TABS[index].path}${search}`)}
            />
          </Card>
        </div>
      </Box>
      <Outlet />
    </>
  );
}
