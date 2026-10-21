/**
 * /admin console markup and the reads it makes (RFC-058 phase 3).
 *
 * Health, push status, and usage are fetched for the selected gateway.
 * The list of other saved gateways is local. Pairing contacts the gateway
 * being added, which then becomes the selected one.
 */

import { creditBadge } from "./credit-badge.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function profilesPath({ usage = false, admin = false } = {}) {
  const q = [];
  if (admin) q.push("admin=1");
  if (usage) q.push("usage=1");
  return q.length ? `/profiles?${q.join("&")}` : "/profiles";
}

/** Reads the control plane makes. Sessions stay first so a failure there still surfaces. */
export function controlPlanePaths({ adminView = false } = {}) {
  const paths = [
    "/sessions?view=summary",
    "/projects",
    profilesPath({ admin: true, usage: Boolean(adminView) }),
    "/mcp/catalog",
  ];
  if (adminView) paths.push("/health", "/push/status");
  return paths;
}

/** Validate + identity. Used when adding a gateway, before it is selected. */
export function pairPaths() {
  return ["/auth/validate", "/host/self"];
}

export function resolveGatewayUrls(baseURL, paths) {
  const root = `${String(baseURL || "").replace(/\/$/, "")}/`;
  return paths.map((p) => new URL(p, root).toString());
}

export function urlsStayOnGateway(baseURL, paths) {
  let origin;
  try {
    origin = new URL(baseURL).origin;
  } catch {
    return false;
  }
  return resolveGatewayUrls(baseURL, paths).every((href) => {
    try {
      return new URL(href).origin === origin;
    } catch {
      return false;
    }
  });
}

/**
 * Push row for the console. The gateway returns configured, deviceCount,
 * and bundleId. Anything else (a device token, a .p8, a key) is dropped.
 */
export function publicPushStatus(status) {
  if (!status || typeof status !== "object") return null;
  if (!("configured" in status) && !("deviceCount" in status) && !("bundleId" in status)) return null;
  const count = Number(status.deviceCount);
  const bundle = status.bundleId == null ? "" : String(status.bundleId);
  return {
    configured: status.configured === true,
    deviceCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
    bundleId: bundle,
  };
}

export function usageLine(profile) {
  const u = profile?.usage;
  if (!u || typeof u !== "object") return "";
  if (u.label) return String(u.label);
  const bits = [];
  if (typeof u.fiveHourPercent === "number" && Number.isFinite(u.fiveHourPercent)) {
    bits.push(`5h ${Math.round(u.fiveHourPercent)}%`);
  }
  if (typeof u.sevenDayPercent === "number" && Number.isFinite(u.sevenDayPercent)) {
    bits.push(`wk ${Math.round(u.sevenDayPercent)}%`);
  }
  if (bits.length) return bits.join(" · ");
  if (u.status) return String(u.status);
  return "";
}

export function publicCatalog(servers) {
  return (servers || [])
    .map((s) => ({ id: String(s?.id || ""), vendor: String(s?.vendor || s?.name || "") }))
    .filter((s) => s.id || s.vendor);
}

export function creditRows(sessions) {
  return (sessions || [])
    .filter((s) => {
      const backend = s?.backend || "grok";
      return backend === "grok" && typeof s?.creditsUsedDeltaPct === "number" && Number.isFinite(s.creditsUsedDeltaPct);
    })
    .map((s) => ({
      title: String(s.title || s.id || "Session"),
      badge: creditBadge(s),
    }))
    .filter((row) => row.badge);
}

export function profileLockCopy(admin) {
  if (admin) {
    return "This browser is on the gateway machine. Profile create and edit still work on the Profiles tab. API keys stay in the gateway config on that machine.";
  }
  return "Profile create and edit are locked from this browser. API keys stay on the host. On the computer running the gateway, open the Host panel or http://127.0.0.1:8787/app/ and use Profiles there.";
}

function fact(label, body) {
  return `<div class="host-fact"><span class="k">${escapeHtml(label)}</span><div class="v">${body}</div></div>`;
}

function hostCard(host, facts) {
  const name = host.label || host.hostId || host.baseURL || "Gateway";
  const idLine = [host.hostId, host.baseURL].filter(Boolean).map((s) => escapeHtml(s)).join(" · ");
  const token = host.tokenSaved ? "Token saved in this browser" : "No token";
  const actions = `
    <div class="row-actions">
      ${host.selected ? "" : `<button type="button" class="secondary" data-select-host="${escapeHtml(host.key)}">Select</button>`}
      <button type="button" class="secondary" data-clear-host="${escapeHtml(host.key)}">Clear token</button>
    </div>`;
  const detail = host.selected
    ? facts
    : [
        fact("Health", "Select to load"),
        fact("Push", "Select to load"),
        fact("Usage", "Select to load"),
      ].join("");
  return `<article class="card host-card${host.selected ? " selected" : ""}" data-host-key="${escapeHtml(host.key)}">
    <div class="row">
      <div>
        <h3>${escapeHtml(name)}${host.selected ? ' <span class="pill ok">selected</span>' : ""}</h3>
        <p class="meta">${idLine}</p>
        <p class="preview">${escapeHtml(token)}</p>
      </div>
      ${actions}
    </div>
    <div class="host-facts">${detail}</div>
  </article>`;
}

function selectedFacts(model) {
  if (model.demo) {
    return [
      fact("Health", "Demo. This page does not contact a gateway."),
      fact("Push", "Demo. No device is registered from here."),
      fact("Usage", "Demo profiles stay on this page."),
      fact("Profiles", escapeHtml(profileLockCopy(false))),
    ].join("");
  }
  if (!model.hasToken) {
    const empty = "Save a token to load this.";
    return [
      fact("Health", escapeHtml(empty)),
      fact("Push", escapeHtml(empty)),
      fact("Usage", escapeHtml(empty)),
      fact("Profiles", escapeHtml(profileLockCopy(false))),
    ].join("");
  }
  const health = model.health;
  const healthText = health?.ok
    ? `Up · ${health.version ? `version ${health.version}` : "version unknown"}${health.name ? ` · ${health.name}` : ""} · ${model.wsOpen ? "WebSocket live" : "WebSocket offline"}`
    : model.healthError || "Gateway unreachable";
  const push = model.push;
  const pushText = push
    ? `${push.configured ? "Configured" : "Not configured"} · ${push.deviceCount} device${push.deviceCount === 1 ? "" : "s"}${push.bundleId ? ` · ${push.bundleId}` : ""}`
    : model.pushError || "Push status unavailable";
  const usage =
    model.profiles?.length
      ? `<ul class="usage-list">${model.profiles
          .map(
            (p) =>
              `<li><strong>${escapeHtml(p.name || p.id)}</strong> <span class="meta">${escapeHtml(p.usageLabel || "no usage reported")}</span></li>`,
          )
          .join("")}</ul>`
      : "No profiles reported";
  const credits = model.credits?.length
    ? model.credits.map((c) => `<div class="credit-row"><span>${escapeHtml(c.title)}</span> ${c.badge}</div>`).join("")
    : `<p class="preview">No Grok session has reported a credit delta.</p>`;
  const catalog = model.catalog?.length
    ? model.catalog.map((s) => escapeHtml(s.vendor ? `${s.vendor} (${s.id})` : s.id)).join(", ")
    : "No catalog reported";
  return [
    fact("Health", escapeHtml(healthText)),
    fact("Push", escapeHtml(pushText)),
    fact("Usage", usage),
    fact("Credits", credits),
    fact("Catalog", escapeHtml(catalog)),
    fact("Profiles", escapeHtml(profileLockCopy(model.admin === true))),
  ].join("");
}

/**
 * @param {object} model
 * @param {Array<{key:string,hostId:string,label:string,baseURL:string,tokenSaved:boolean,selected:boolean}>} model.hosts
 * Tokens are not a field on the view model and are not written into the page.
 */
export function adminConsoleHtml(model) {
  const hosts = model.hosts || [];
  const facts = hosts.some((h) => h.selected) ? selectedFacts(model) : "";
  const cards = hosts.length
    ? hosts.map((h) => hostCard(h, h.selected ? facts : "")).join("")
    : `<p class="preview">No gateway saved in this browser yet.</p>`;
  const demo = model.demo
    ? `<p class="preview" id="admin-demo-note">Demo data. This page does not save a gateway and does not contact one.</p>`
    : "";
  return `${demo}
    <div class="card" id="admin-add">
      <h3>Add a gateway</h3>
      <p class="preview">Paste the base URL and the host token from <code>/setup</code> on the gateway machine. The token stays in this browser. This site does not keep a copy.</p>
      <label class="field" for="host-add-label">Label</label>
      <input id="host-add-label" autocomplete="off" placeholder="Optional name" />
      <label class="field" for="host-add-url">Host URL</label>
      <input id="host-add-url" autocomplete="off" placeholder="http://127.0.0.1:8787 or https://machine.tailnet.ts.net" />
      <label class="field" for="host-add-token">Host token</label>
      <input id="host-add-token" autocomplete="off" placeholder="Paste the token" />
      <button type="button" class="primary" id="host-add-save" style="width:100%;margin-top:12px">Save gateway</button>
    </div>
    <div class="host-list" id="admin-host-list">${cards}</div>`;
}
