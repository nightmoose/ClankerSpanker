/**
 * How the browser control plane reaches a gateway.
 *
 * The hosted page at https://clankerspanker.tech calls a gateway on the same
 * computer. Chrome allows that after the loopback permission. Other browsers
 * do not. Keep HOSTED_PRODUCT_ORIGIN in sync with host/src/trusted-local.ts.
 */

export const HOSTED_PRODUCT_ORIGIN = "https://clankerspanker.tech";
export const LOOPBACK_GATEWAY = "http://127.0.0.1:8787";
export const LOOPBACK_SETUP = "http://127.0.0.1:8787/setup";
export const LOOPBACK_APP = "http://127.0.0.1:8787/app/";

export function isLoopbackHost(hostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** `production` on the public site, `preview` on a Vercel preview, otherwise null. */
export function productSiteKind(hostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "clankerspanker.tech" || host === "www.clankerspanker.tech") return "production";
  if (host.endsWith(".vercel.app")) return "preview";
  return null;
}

/**
 * Chrome, including desktop Chrome. Edge, Opera, Samsung Internet, iOS Chrome
 * (WebKit), and Brave are not Chrome. Brave shares Chrome's user-agent string;
 * pass `brave: true` when `navigator.brave` exists.
 */
export function isChromeUserAgent(userAgent, hints = {}) {
  if (hints.brave) return false;
  const ua = String(userAgent || "");
  if (!/Chrome\/\d+/.test(ua)) return false;
  if (/Edg\/|EdgiOS|OPR\/|OPiOS|SamsungBrowser|CriOS/.test(ua)) return false;
  return true;
}

/**
 * Fetch options for a loopback gateway. Other hosts, including a tailnet
 * name, must not declare `loopback` — Chrome blocks a name that does not
 * resolve into the declared address space.
 */
export function loopbackFetchInit(url) {
  if (!isLoopbackHost(hostnameOf(url))) return {};
  return { targetAddressSpace: "loopback", mode: "cors" };
}

/** WebSocket options bag. Null when the URL is not loopback. */
export function websocketOptions(url) {
  if (!isLoopbackHost(hostnameOf(url))) return null;
  return { targetAddressSpace: "loopback" };
}

/**
 * Stored host URL wins. On the public site, with nothing stored, the gateway
 * is loopback on this computer rather than the page's own origin.
 */
export function defaultGatewayURL({ hostname, stored }) {
  const saved = String(stored || "").trim();
  if (saved) return saved;
  if (productSiteKind(hostname)) return LOOPBACK_GATEWAY;
  return "";
}

export function publicPageNotice({ hostname, userAgent, brave = false }) {
  const kind = productSiteKind(hostname);
  if (!kind) return "";
  const chrome = isChromeUserAgent(userAgent, { brave });
  if (kind === "preview") {
    const preview =
      "This is a preview deployment, not the product. Do not paste a host token here. Open https://clankerspanker.tech instead.";
    if (chrome) return preview;
    return `${preview} Chrome is also the only browser that can reach a gateway on this computer from the public site.`;
  }
  if (chrome) return "";
  return (
    "Chrome is the browser that can reach a gateway on this computer from https://clankerspanker.tech. " +
    "Firefox, Safari, and other browsers do not, so this page cannot connect from them. " +
    `On the computer running the gateway, open ${LOOPBACK_APP} yourself. This site does not redirect you there.`
  );
}

export function loopbackUnreachableMessage(baseURL) {
  const where = String(baseURL || LOOPBACK_GATEWAY);
  return (
    `Could not reach the gateway at ${where}. In Chrome, allow loopback access for this site. ` +
    `The gateway must be running on this computer. Copy the token from ${LOOPBACK_SETUP} on that machine.`
  );
}

const FETCH_FAILED = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * Replace a bare network failure on the public site with the limit that
 * applies. Other errors (a rejected token, for example) pass through.
 */
export function explainFetchFailure({ hostname, userAgent, brave = false, baseURL, errorMessage }) {
  const notice = publicPageNotice({ hostname, userAgent, brave });
  const failed = !errorMessage || FETCH_FAILED.test(errorMessage);
  if (notice && (failed || !isChromeUserAgent(userAgent, { brave }))) return notice;
  if (failed && productSiteKind(hostname) && isLoopbackHost(hostnameOf(baseURL))) {
    return loopbackUnreachableMessage(baseURL);
  }
  return errorMessage || "Could not reach the gateway.";
}
