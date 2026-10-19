/**
 * How the browser control plane reaches a gateway.
 *
 * The hosted page at https://clankerspanker.tech calls either a gateway on the
 * same computer (http://127.0.0.1:8787, Chrome only, after the loopback
 * permission) or a gateway on the user's tailnet through `tailscale serve`
 * (https://<node>.<tailnet>.ts.net, any browser, RFC-058 phase 2).
 * Keep HOSTED_PRODUCT_ORIGIN in sync with host/src/trusted-local.ts.
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

/**
 * A `tailscale serve` HTTPS name: `https://<node>.<tailnet>.ts.net`. HTTPS
 * from an HTTPS page is not mixed content, so this works in every browser.
 */
export function isTailnetServeURL(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const labels = u.hostname.toLowerCase().replace(/\.$/, "").split(".");
    return labels.length >= 4 && labels.at(-2) === "ts" && labels.at(-1) === "net" && labels.every(Boolean);
  } catch {
    return false;
  }
}

/**
 * What the Host URL field saved. Trims, drops trailing slashes, and gives a
 * bare `node.tailnet.ts.net` the `https://` Serve answers on. Anything else
 * is left alone.
 */
export function normalizeHostURL(input) {
  let v = String(input || "").trim().replace(/\/+$/, "");
  if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && isTailnetServeURL(`https://${v}`)) v = `https://${v}`;
  return v;
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
 * Whether this page may offer "Update this host" (RFC-059). The gateway only
 * honors `/host/update` from native apps and from its own page on the direct
 * listener, so the button shows only when the page and the gateway share an
 * origin and that origin is not a `tailscale serve` name. The hosted site,
 * Vercel previews, and any page pointed at another gateway hide it.
 */
export function hostUpdateAvailable({ pageOrigin, baseURL, hostname }) {
  if (productSiteKind(hostname)) return false;
  if (isTailnetServeURL(pageOrigin) || isTailnetServeURL(baseURL)) return false;
  try {
    return new URL(baseURL).origin === new URL(pageOrigin).origin;
  } catch {
    return false;
  }
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
 *
 * A `*.ts.net` gateway gets no `targetAddressSpace` either, not even
 * `local`. The option exists so Chrome can skip mixed-content blocking for
 * an `http:` target it knows is local before DNS. A ts.net target is
 * `https:`, so there is nothing to skip: Chrome resolves the name (100.64/10,
 * "local" in the LNA spec) and shows its local-network prompt on its own.
 * Declaring `local` would only add a way to fail, for a name that resolves
 * elsewhere (MagicDNS off, or a public resolver).
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
 * Whether this page's browser accepts `{ targetAddressSpace }` as the
 * WebSocket constructor's second argument.
 *
 * `unknown` until the first loopback socket. `no` after Chrome rejects the
 * bag. `yes` after a browser accepts it. Remembered so a rejected bag is
 * not passed again.
 */
let websocketOptionsBag = "unknown";

export function resetWebSocketOptionsProbe() {
  websocketOptionsBag = "unknown";
}

/**
 * Chrome 154.0.8037.92 throws
 * `Failed to construct 'WebSocket': The subprotocol '[object Object]' is invalid`
 * because it still reads the second argument as a subprotocol list, not as
 * the options bag from the Chrome 154 release notes. The throw is caught.
 * Later calls on this page skip the bag, so the constructor is not invoked
 * with an object again and the console is not filled with that error.
 * A browser that accepts the bag keeps receiving it.
 */
function optionsBagRejected(err) {
  const msg = String((err && err.message) || err || "");
  return /subprotocol/i.test(msg) || msg.includes("[object Object]");
}

export function openWebSocket(url, options, Factory) {
  const WS = Factory || globalThis.WebSocket;
  const tryBag = Boolean(options) && websocketOptionsBag !== "no";
  if (!tryBag) return new WS(url);
  try {
    const ws = new WS(url, options);
    websocketOptionsBag = "yes";
    return ws;
  } catch (err) {
    if (!optionsBagRejected(err)) throw err;
    websocketOptionsBag = "no";
    return new WS(url);
  }
}

/** Gateway-served terminal. The static site does not host this page. */
export function gatewayTerminalURL(baseURL) {
  const base = String(baseURL || LOOPBACK_GATEWAY).replace(/\/$/, "");
  return `${base}/app/terminal.html`;
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

export function publicPageNotice({ hostname, userAgent, brave = false, baseURL = "" }) {
  const kind = productSiteKind(hostname);
  if (!kind) return "";
  const chrome = isChromeUserAgent(userAgent, { brave });
  if (kind === "preview") {
    const preview =
      "This is a preview deployment, not the product. Do not paste a host token here. Open https://clankerspanker.tech instead.";
    if (chrome) return preview;
    return `${preview} Chrome is also the only browser that can reach a gateway on this computer from the public site.`;
  }
  if (chrome || isTailnetServeURL(baseURL)) return "";
  return (
    "Only Chrome can reach a gateway on this computer (http://127.0.0.1) from https://clankerspanker.tech. " +
    "In Firefox, Safari, and other browsers, connect over your tailnet instead: run `tailscale serve` on the gateway machine " +
    "and set Host URL to the https://<machine>.<tailnet>.ts.net address it prints (see /download/). " +
    `Or, on the computer running the gateway, open ${LOOPBACK_APP} yourself. This site does not redirect you there.`
  );
}

export function loopbackUnreachableMessage(baseURL) {
  const where = String(baseURL || LOOPBACK_GATEWAY);
  return (
    `Could not reach the gateway at ${where}. In Chrome, allow loopback access for this site. ` +
    `The gateway must be running on this computer. Copy the token from ${LOOPBACK_SETUP} on that machine.`
  );
}

export function tailnetUnreachableMessage(baseURL) {
  return (
    `Could not reach the gateway at ${baseURL}. Check that this device is signed in to the same tailnet, ` +
    "that `tailscale serve` is running on the gateway machine against its serveBindPort, and that the gateway is up. " +
    "In Chrome, allow local network access for this site."
  );
}

const FETCH_FAILED = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * Replace a bare network failure on the public site with the limit that
 * applies. Other errors (a rejected token, for example) pass through.
 */
export function explainFetchFailure({ hostname, userAgent, brave = false, baseURL, errorMessage }) {
  const notice = publicPageNotice({ hostname, userAgent, brave, baseURL });
  const failed = !errorMessage || FETCH_FAILED.test(errorMessage);
  if (notice && (failed || !isChromeUserAgent(userAgent, { brave }))) return notice;
  if (failed && productSiteKind(hostname) && isTailnetServeURL(baseURL)) {
    return tailnetUnreachableMessage(baseURL);
  }
  if (failed && productSiteKind(hostname) && isLoopbackHost(hostnameOf(baseURL))) {
    return loopbackUnreachableMessage(baseURL);
  }
  return errorMessage || "Could not reach the gateway.";
}
