/**
 * Paired gateways saved in this browser (RFC-058 phase 3).
 *
 * One record per hostId: { hostId, label, baseURL, token }.
 * The list replaces the single clankerspanker.token / clankerspanker.hostURL
 * pair as the source of truth. Those two keys are still written for the
 * selected host so the gateway terminal page, which reads the token key
 * itself, keeps working. Two browsers do not sync.
 */

import { normalizeHostURL } from "./gateway-client.js";

export const HOSTS_STORAGE_KEY = "clankerspanker.hosts";
export const ACTIVE_HOST_STORAGE_KEY = "clankerspanker.activeHostId";
export const LEGACY_TOKEN_KEY = "clankerspanker.token";
export const LEGACY_URL_KEY = "clankerspanker.hostURL";

export function recordKey(record) {
  if (!record) return "";
  const hostId = String(record.hostId || "").trim();
  if (hostId) return hostId;
  const baseURL = normalizeHostURL(record.baseURL || "");
  return baseURL ? `url:${baseURL}` : "";
}

export function normalizeHostRecord(input) {
  return {
    hostId: String(input?.hostId || "").trim(),
    label: String(input?.label || "").trim(),
    baseURL: normalizeHostURL(input?.baseURL || ""),
    token: String(input?.token || "").trim(),
  };
}

/** Replace the record with the same hostId, or the same not-yet-identified URL. */
export function upsertHost(hosts, input) {
  const next = normalizeHostRecord(input);
  if (!next.hostId && !next.baseURL) return hosts.map((h) => ({ ...h }));
  const out = [];
  let placed = false;
  for (const h of hosts) {
    const sameId = Boolean(next.hostId) && h.hostId === next.hostId;
    const pendingSameUrl = Boolean(next.hostId) && !h.hostId && next.baseURL && h.baseURL === next.baseURL;
    const samePending = !next.hostId && !h.hostId && next.baseURL && h.baseURL === next.baseURL;
    if (sameId || pendingSameUrl || samePending) {
      if (!placed) {
        out.push({
          hostId: next.hostId || h.hostId,
          label: next.label || h.label,
          baseURL: next.baseURL || h.baseURL,
          token: next.token,
        });
        placed = true;
      }
      continue;
    }
    out.push({ ...h });
  }
  if (!placed) out.push(next);
  return out;
}

export function parseHostList(raw) {
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  let hosts = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const rec = normalizeHostRecord(item);
    if (!rec.hostId && !rec.baseURL) continue;
    hosts = upsertHost(hosts, rec);
  }
  return hosts;
}

export function activeRecord(hosts, activeHostId) {
  const key = String(activeHostId || "");
  if (!key) return null;
  return hosts.find((h) => recordKey(h) === key) || null;
}

/**
 * Load the list. When the list is empty and the legacy pair is present,
 * that pair becomes the first record. An existing list is left as-is.
 */
export function loadPairedHosts(storage) {
  const hosts = parseHostList(storage.getItem(HOSTS_STORAGE_KEY));
  let activeHostId = String(storage.getItem(ACTIVE_HOST_STORAGE_KEY) || "");
  let changed = false;
  let list = hosts;
  if (!list.length) {
    const token = String(storage.getItem(LEGACY_TOKEN_KEY) || "").trim();
    const baseURL = normalizeHostURL(storage.getItem(LEGACY_URL_KEY) || "");
    if (token || baseURL) {
      list = [{ hostId: "", label: "", baseURL, token }];
      activeHostId = recordKey(list[0]);
      changed = true;
    }
  }
  if (activeHostId && !list.some((h) => recordKey(h) === activeHostId)) {
    activeHostId = list[0] ? recordKey(list[0]) : "";
    changed = true;
  }
  if (!activeHostId && list[0]) {
    activeHostId = recordKey(list[0]);
    changed = true;
  }
  return { hosts: list, activeHostId, changed };
}

export function clearHostToken(hosts, key) {
  const id = String(key || "");
  return hosts.map((h) => (recordKey(h) === id ? { ...h, token: "" } : { ...h }));
}

/** True when the operator moved from one saved gateway to another. */
export function hostSwitchDropsSessions(prevKey, nextKey) {
  const next = String(nextKey || "");
  if (!next) return false;
  return String(prevKey || "") !== next;
}

export function persistPairedHosts(storage, { hosts, activeHostId }) {
  storage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(hosts));
  storage.setItem(ACTIVE_HOST_STORAGE_KEY, String(activeHostId || ""));
  const active = activeRecord(hosts, activeHostId);
  if (active?.token) storage.setItem(LEGACY_TOKEN_KEY, active.token);
  else storage.removeItem(LEGACY_TOKEN_KEY);
  if (active?.baseURL) storage.setItem(LEGACY_URL_KEY, active.baseURL);
  else storage.removeItem(LEGACY_URL_KEY);
}

export function isAdminConsolePath(pathname) {
  return /^\/admin(?:\/(?:index\.html)?)?$/.test(String(pathname || ""));
}
