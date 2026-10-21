/**
 * Per-session Grok credit meter badge (RFC-021).
 * Grok sessions carry creditsUsedDeltaPct. Other backends leave it unset,
 * and this returns nothing for those.
 */

function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function creditBadge(s) {
  const delta = typeof s?.creditsUsedDeltaPct === "number" ? s.creditsUsedDeltaPct : null;
  if (delta == null || !Number.isFinite(delta)) return "";
  const tier = delta >= 10 ? "red" : delta >= 5 ? "amber" : "green";
  const rounded = delta < 1 ? delta.toFixed(1) : Math.round(delta).toString();
  const title =
    tier === "green"
      ? `This chat has burned ${rounded}% of the weekly Grok plan.`
      : `This chat has burned ${rounded}% of the weekly Grok plan. Consider reincarnating.`;
  return `<span class="credit-badge credit-${tier}" title="${escapeAttr(title)}">wk +${rounded}%</span>`;
}
