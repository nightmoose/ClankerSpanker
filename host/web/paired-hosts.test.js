import { describe, expect, it } from "vitest";
import {
  ACTIVE_HOST_STORAGE_KEY,
  HOSTS_STORAGE_KEY,
  LEGACY_TOKEN_KEY,
  LEGACY_URL_KEY,
  activeRecord,
  clearHostToken,
  hostSwitchDropsSessions,
  isAdminConsolePath,
  loadPairedHosts,
  parseHostList,
  persistPairedHosts,
  recordKey,
  upsertHost,
} from "./paired-hosts.js";

function memoryStorage(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

const hostA = {
  hostId: "host-a",
  label: "Laptop",
  baseURL: "http://127.0.0.1:8787",
  token: "token-a",
};
const hostB = {
  hostId: "host-b",
  label: "Desk",
  baseURL: "https://desk.tailnet.ts.net",
  token: "token-b",
};

describe("paired host list", () => {
  it("keeps one record per hostId and replaces that record in place", () => {
    const first = upsertHost([], hostA);
    const second = upsertHost(first, hostB);
    expect(second).toHaveLength(2);
    const replaced = upsertHost(second, {
      hostId: "host-a",
      label: "Laptop",
      baseURL: "http://127.0.0.1:8790",
      token: "token-a-new",
    });
    expect(replaced).toHaveLength(2);
    expect(replaced.find((h) => h.hostId === "host-a")).toMatchObject({
      baseURL: "http://127.0.0.1:8790",
      token: "token-a-new",
    });
    expect(replaced.find((h) => h.hostId === "host-b").token).toBe("token-b");
  });

  it("promotes a pending URL to a hostId without leaving a duplicate", () => {
    const pending = upsertHost([], {
      hostId: "",
      label: "",
      baseURL: "http://127.0.0.1:8787",
      token: "token-a",
    });
    expect(recordKey(pending[0])).toBe("url:http://127.0.0.1:8787");
    const named = upsertHost(pending, hostA);
    expect(named).toHaveLength(1);
    expect(named[0].hostId).toBe("host-a");
    expect(named[0].token).toBe("token-a");
  });

  it("drops a duplicate hostId while parsing, last record wins", () => {
    const raw = JSON.stringify([
      hostA,
      { ...hostA, token: "later" },
      "nope",
      null,
      { label: "missing both" },
    ]);
    const list = parseHostList(raw);
    expect(list).toHaveLength(1);
    expect(list[0].token).toBe("later");
    expect(parseHostList("not json")).toEqual([]);
    expect(parseHostList("{\"hostId\":\"x\"}")).toEqual([]);
  });

  it("clears one host's token and leaves the other host in place", () => {
    const list = upsertHost(upsertHost([], hostA), hostB);
    const cleared = clearHostToken(list, "host-a");
    expect(cleared.find((h) => h.hostId === "host-a")).toMatchObject({
      hostId: "host-a",
      label: "Laptop",
      baseURL: "http://127.0.0.1:8787",
      token: "",
    });
    expect(cleared.find((h) => h.hostId === "host-b")).toEqual(hostB);
  });

  it("marks a switch to another host as dropping in-memory sessions", () => {
    expect(hostSwitchDropsSessions("host-a", "host-b")).toBe(true);
    expect(hostSwitchDropsSessions("host-a", "host-a")).toBe(false);
    expect(hostSwitchDropsSessions("", "host-a")).toBe(true);
    expect(hostSwitchDropsSessions("host-a", "")).toBe(false);
  });
});

describe("paired host storage", () => {
  it("migrates the legacy token pair into the list once", () => {
    const storage = memoryStorage({
      [LEGACY_TOKEN_KEY]: "token-a",
      [LEGACY_URL_KEY]: "http://127.0.0.1:8787",
    });
    const loaded = loadPairedHosts(storage);
    expect(loaded.changed).toBe(true);
    expect(loaded.hosts).toEqual([
      { hostId: "", label: "", baseURL: "http://127.0.0.1:8787", token: "token-a" },
    ]);
    persistPairedHosts(storage, loaded);
    const again = loadPairedHosts(storage);
    expect(again.changed).toBe(false);
    expect(again.hosts).toEqual(loaded.hosts);
    expect(again.activeHostId).toBe(loaded.activeHostId);
  });

  it("reloads two hosts and keeps the selected one", () => {
    const storage = memoryStorage();
    const hosts = upsertHost(upsertHost([], hostA), hostB);
    persistPairedHosts(storage, { hosts, activeHostId: "host-b" });
    const loaded = loadPairedHosts(storage);
    expect(loaded.changed).toBe(false);
    expect(loaded.hosts).toEqual(hosts);
    expect(loaded.activeHostId).toBe("host-b");
    expect(activeRecord(loaded.hosts, loaded.activeHostId)).toEqual(hostB);
    expect(storage.getItem(LEGACY_TOKEN_KEY)).toBe("token-b");
    expect(storage.getItem(LEGACY_URL_KEY)).toBe("https://desk.tailnet.ts.net");
  });

  it("clearing the selected token removes the legacy token and leaves the other host", () => {
    const storage = memoryStorage();
    const hosts = clearHostToken(upsertHost(upsertHost([], hostA), hostB), "host-a");
    persistPairedHosts(storage, { hosts, activeHostId: "host-a" });
    const loaded = loadPairedHosts(storage);
    expect(loaded.hosts.find((h) => h.hostId === "host-b").token).toBe("token-b");
    expect(loaded.hosts.find((h) => h.hostId === "host-a").token).toBe("");
    expect(storage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
    expect(storage.getItem(HOSTS_STORAGE_KEY)).toContain("token-b");
    expect(storage.getItem(ACTIVE_HOST_STORAGE_KEY)).toBe("host-a");
  });

  it("does not rebuild the list from the legacy keys when a list is already stored", () => {
    const hosts = upsertHost(upsertHost([], hostA), hostB);
    const storage = memoryStorage({
      [HOSTS_STORAGE_KEY]: JSON.stringify(hosts),
      [ACTIVE_HOST_STORAGE_KEY]: "host-a",
      [LEGACY_TOKEN_KEY]: "token-a",
      [LEGACY_URL_KEY]: "http://127.0.0.1:8787",
    });
    const loaded = loadPairedHosts(storage);
    expect(loaded.hosts).toHaveLength(2);
    expect(loaded.changed).toBe(false);
  });
});

describe("admin path", () => {
  it("recognizes the published /admin page and ignores the rest of the site", () => {
    expect(isAdminConsolePath("/admin")).toBe(true);
    expect(isAdminConsolePath("/admin/")).toBe(true);
    expect(isAdminConsolePath("/admin/index.html")).toBe(true);
    expect(isAdminConsolePath("/")).toBe(false);
    expect(isAdminConsolePath("/app/")).toBe(false);
    expect(isAdminConsolePath("/docs/")).toBe(false);
    expect(isAdminConsolePath("/administration")).toBe(false);
  });
});
