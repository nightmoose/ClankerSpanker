"use strict";

/**
 * Host REST client. Connection (URL + token) comes from the desktop shell.
 */
const Api = (() => {
  let hostURL = "http://127.0.0.1:8787";
  let token = "";

  function setConnection({ hostURL: url, token: t } = {}) {
    if (url) hostURL = String(url).replace(/\/$/, "");
    if (t !== undefined) token = String(t || "");
  }

  function getConnection() {
    return { hostURL, token };
  }

  async function request(path, opts = {}) {
    if (!token) throw new Error("No host token — start the host or set a token in Desktop settings");
    const url = new URL(path, hostURL + "/");
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text };
    }
    if (!res.ok) {
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    return body;
  }

  return {
    setConnection,
    getConnection,
    request,
    validate: () => request("/auth/validate", { method: "POST", body: "{}" }),
    health: async () => {
      const res = await fetch(`${hostURL}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    sessions: () => request("/sessions"),
    session: (id) => request(`/sessions/${encodeURIComponent(id)}`),
    projects: () => request("/projects"),
    profiles: () => request("/profiles"),
    dispatch: (body) => request("/dispatch", { method: "POST", body: JSON.stringify(body) }),
    prompt: (id, body) =>
      request(`/sessions/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    approve: (id, body) =>
      request(`/sessions/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    reject: (id, body) =>
      request(`/sessions/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    answer: (id, body) =>
      request(`/sessions/${encodeURIComponent(id)}/answer-questions`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    archive: (id) =>
      request(`/sessions/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
    unarchive: (id) =>
      request(`/sessions/${encodeURIComponent(id)}/unarchive`, { method: "POST", body: "{}" }),
    cancel: (id) =>
      request(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
    attachGrok: (body) => request("/sessions/attach", { method: "POST", body: JSON.stringify(body) }),
    attachClaude: (body) =>
      request("/sessions/attach-claude", { method: "POST", body: JSON.stringify(body) }),
  };
})();
