// Loyalty messaging helpers used by both the admin page (in the browser) and
// the server. Storage lives in loyaltyMessages.server.js.

export const TONES = ["info", "success", "warning", "critical"];
export const AUDIENCES = ["all", "members", "nonMembers"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Message shape. Dates are YYYY-MM-DD and inclusive; the page compares them in
// the customer's local time. Blank dates = no limit.
export function normalizeMessage(raw, index = 0) {
  const str = (v) => String(v ?? "").trim();
  return {
    id: str(raw?.id) || `msg-${Date.now()}-${index}`,
    heading: str(raw?.heading),
    text: str(raw?.text),
    linkLabel: str(raw?.linkLabel),
    linkUrl: str(raw?.linkUrl),
    tone: TONES.includes(raw?.tone) ? raw.tone : "info",
    audience: AUDIENCES.includes(raw?.audience) ? raw.audience : "all",
    startsOn: DATE.test(str(raw?.startsOn)) ? str(raw.startsOn) : "",
    endsOn: DATE.test(str(raw?.endsOn)) ? str(raw.endsOn) : "",
  };
}

// Problems that should block a save, as readable strings.
export function validateMessages(messages) {
  const errors = [];
  messages.forEach((m, i) => {
    const label = `Message ${i + 1}`;
    if (!m.text) errors.push(`${label}: text can't be empty.`);
    if (m.linkLabel && !m.linkUrl) errors.push(`${label}: add a link URL or remove the link text.`);
    if (m.linkUrl && !/^(https:\/\/|\/)/.test(m.linkUrl)) {
      errors.push(`${label}: link URL must start with https:// or / (a storefront path).`);
    }
    if (m.startsOn && m.endsOn && m.endsOn < m.startsOn) errors.push(`${label}: end date is before start date.`);
  });
  return errors;
}
