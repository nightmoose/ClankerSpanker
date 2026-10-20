/**
 * What the control plane shows first (RFC-067).
 *
 * A visitor with no host configured gets the explainer and the connection
 * form instead of a bare form. `?demo=1` opens the read-only demo; it is
 * only ever chosen, never a default, on the hosted site or on a gateway.
 */

export function demoRequested(search) {
  const v = new URLSearchParams(String(search || "")).get("demo");
  return v === "1" || v === "true" || v === "";
}

/** `demo`, `explainer` (no host token saved), or `app`. */
export function landingView({ token, demo }) {
  if (demo) return "demo";
  if (!String(token || "").trim()) return "explainer";
  return "app";
}

/** The same page with `demo` set or removed; other parameters are kept. */
export function demoHref({ pathname, search, hash = "" }, on) {
  const q = new URLSearchParams(String(search || ""));
  if (on) q.set("demo", "1");
  else q.delete("demo");
  const s = q.toString();
  return `${pathname}${s ? `?${s}` : ""}${hash}`;
}
