"use strict";

/**
 * Host REST client. Connection (URL + token) comes from the desktop shell.
 *
 * RFC-025: every method accepts an optional trailing `hostConn` of
 * `{ hostURL, token }` to route the call to a specific host. When absent,
 * the module-level singleton (the currently active host) is used. Use
 * `Api.forHost(hostConn)` to get a facade that auto-passes `hostConn` for
 * every call — needed anywhere the caller knows *which* host owns the
 * session/bot/task being touched.
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

  function enc(id) {
    return encodeURIComponent(id);
  }

  /** Pick the connection to use for a request: caller-supplied override
   *  falls back to the module singleton. */
  function resolveConn(hostConn) {
    if (hostConn && hostConn.hostURL) {
      return {
        hostURL: String(hostConn.hostURL).replace(/\/$/, ""),
        token: String(hostConn.token || ""),
      };
    }
    return { hostURL, token };
  }

  async function request(path, opts = {}, hostConn) {
    const conn = resolveConn(hostConn);
    if (!conn.token) throw new Error("No host token — start the host or set a token in Desktop settings");
    const url = new URL(path, conn.hostURL + "/");
    const headers = {
      Authorization: `Bearer ${conn.token}`,
      ...(opts.headers || {}),
    };
    if (opts.body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401) {
      // RFC-049: say what happened instead of a bare "Unauthorized".
      throw new Error(
        `${conn.hostURL} rejected the saved token (it may have been rotated). Copy the new token from /setup on that machine into Settings → Hosts.`,
      );
    }
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

  async function requestRaw(path, hostConn) {
    const conn = resolveConn(hostConn);
    if (!conn.token) throw new Error("No host token — start the host or set a token in Desktop settings");
    const url = new URL(path, conn.hostURL + "/");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${conn.token}` },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const t = await res.text();
        const j = t ? JSON.parse(t) : null;
        if (j?.error) msg = j.error;
      } catch {
        /* */
      }
      throw new Error(msg);
    }
    const buffer = await res.arrayBuffer();
    return {
      buffer,
      contentType: res.headers.get("content-type") || "application/octet-stream",
    };
  }

  function jsonBody(obj) {
    return JSON.stringify(obj ?? {});
  }

  const methods = {
    setConnection,
    getConnection,
    request,
    requestRaw,
    validate: (hostConn) => request("/auth/validate", { method: "POST", body: "{}" }, hostConn),
    health: async (hostConn) => {
      const conn = resolveConn(hostConn);
      const res = await fetch(`${conn.hostURL}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    /** RFC-024: stable host identity + basics. Auth required. */
    hostSelf: (hostConn) => request("/host/self", {}, hostConn),

    sessions: (query, hostConn) => {
      const q = String(query || "").trim();
      return request(q ? `/sessions?q=${encodeURIComponent(q)}` : "/sessions", {}, hostConn);
    },
    session: (id, hostConn) => request(`/sessions/${enc(id)}`, {}, hostConn),
    events: (id, since = 0, hostConn) =>
      request(`/sessions/${enc(id)}/events?since=${encodeURIComponent(since)}`, {}, hostConn),
    diff: (id, hostConn) => request(`/sessions/${enc(id)}/diff`, {}, hostConn),
    sessionFiles: (id, hostConn) => request(`/sessions/${enc(id)}/files`, {}, hostConn),
    sessionFile: (id, filePath, hostConn) =>
      request(`/sessions/${enc(id)}/file?path=${encodeURIComponent(filePath)}`, {}, hostConn),
    addExtraDirs: (id, extraDirs, hostConn) =>
      request(`/sessions/${enc(id)}/extra-dirs`, {
        method: "PATCH",
        body: jsonBody({ extraDirs }),
      }, hostConn),

    projects: (hostConn) => request("/projects", {}, hostConn),
    project: (id, hostConn) => request(`/projects/${enc(id)}`, {}, hostConn),
    createProject: (body, hostConn) => request("/projects", { method: "POST", body: jsonBody(body) }, hostConn),
    updateProject: (id, body, hostConn) =>
      request(`/projects/${enc(id)}`, { method: "PATCH", body: jsonBody(body) }, hostConn),
    deleteProject: (id, hard = false, hostConn) =>
      request(`/projects/${enc(id)}${hard ? "?hard=1" : ""}`, { method: "DELETE" }, hostConn),
    discoverProjects: (hostConn) => request("/projects/discover", { method: "POST", body: "{}" }, hostConn),
    uploadProjectAttachment: (projectId, body, hostConn) =>
      request(`/projects/${enc(projectId)}/attachments`, {
        method: "POST",
        body: jsonBody(body),
      }, hostConn),
    fetchProjectAttachment: (projectId, attachmentId, hostConn) =>
      requestRaw(`/projects/${enc(projectId)}/attachments/${enc(attachmentId)}`, hostConn),
    deleteProjectAttachment: (projectId, attachmentId, hostConn) =>
      request(`/projects/${enc(projectId)}/attachments/${enc(attachmentId)}`, {
        method: "DELETE",
      }, hostConn),

    profiles: (opts = {}, hostConn) => {
      const params = new URLSearchParams();
      if (opts.usage) params.set("usage", "1");
      if (opts.admin) params.set("admin", "1");
      const qs = params.toString();
      return request(qs ? `/profiles?${qs}` : "/profiles", {}, hostConn);
    },
    loginProfile: (id, body = {}, hostConn) =>
      request(`/profiles/${enc(id)}/login`, { method: "POST", body: jsonBody(body) }, hostConn),
    createProfile: (body, hostConn) =>
      request("/profiles", { method: "POST", body: jsonBody(body) }, hostConn),
    updateProfile: (id, body, hostConn) =>
      request(`/profiles/${enc(id)}`, { method: "PATCH", body: jsonBody(body) }, hostConn),
    deleteProfile: (id, hostConn) =>
      request(`/profiles/${enc(id)}`, { method: "DELETE" }, hostConn),

    dispatch: (body, hostConn) => request("/dispatch", { method: "POST", body: jsonBody(body) }, hostConn),
    toolCall: (sessionId, toolCallId, hostConn) =>
      request(`/sessions/${enc(sessionId)}/tool-calls/${enc(toolCallId)}`, {}, hostConn),
    prompt: (id, body, hostConn) =>
      request(`/sessions/${enc(id)}/prompt`, { method: "POST", body: jsonBody(body) }, hostConn),
    approve: (id, body, hostConn) =>
      request(`/sessions/${enc(id)}/approve`, { method: "POST", body: jsonBody(body) }, hostConn),
    reject: (id, body, hostConn) =>
      request(`/sessions/${enc(id)}/reject`, { method: "POST", body: jsonBody(body) }, hostConn),
    answer: (id, body, hostConn) =>
      request(`/sessions/${enc(id)}/answer-questions`, {
        method: "POST",
        body: jsonBody(body),
      }, hostConn),
    archive: (id, hostConn) => request(`/sessions/${enc(id)}/archive`, { method: "POST", body: "{}" }, hostConn),
    unarchive: (id, hostConn) =>
      request(`/sessions/${enc(id)}/unarchive`, { method: "POST", body: "{}" }, hostConn),
    cancel: (id, hostConn) => request(`/sessions/${enc(id)}/cancel`, { method: "POST", body: "{}" }, hostConn),
    close: (id, hostConn) => request(`/sessions/${enc(id)}/close`, { method: "POST", body: "{}" }, hostConn),
    deleteSession: (id, hostConn) => request(`/sessions/${enc(id)}`, { method: "DELETE" }, hostConn),
    renameSession: (id, title, hostConn) =>
      request(`/sessions/${enc(id)}/title`, { method: "POST", body: jsonBody({ title }) }, hostConn),
    transferSession: (id, profileId, hostConn) =>
      request(`/sessions/${enc(id)}/transfer`, {
        method: "POST",
        body: jsonBody({ profileId }),
      }, hostConn),
    reincarnateSession: (id, body = {}, hostConn) =>
      request(`/sessions/${enc(id)}/reincarnate`, { method: "POST", body: jsonBody(body) }, hostConn),
    reviewSession: (id, body = {}, hostConn) =>
      request(`/sessions/${enc(id)}/review`, { method: "POST", body: jsonBody(body) }, hostConn),
    setSessionProject: (id, projectId, hostConn) =>
      request(`/sessions/${enc(id)}/project`, {
        method: "POST",
        body: jsonBody({ projectId: projectId || null }),
      }, hostConn),

    listTasks: (status, hostConn) => {
      const q = status ? `?status=${encodeURIComponent(status)}` : "";
      return request(`/tasks${q}`, {}, hostConn);
    },
    createTask: (sessionId, body, hostConn) =>
      request(`/sessions/${enc(sessionId)}/tasks`, { method: "POST", body: jsonBody(body) }, hostConn),
    updateTask: (sessionId, taskId, body, hostConn) =>
      request(`/sessions/${enc(sessionId)}/tasks/${enc(taskId)}`, {
        method: "PATCH",
        body: jsonBody(body),
      }, hostConn),
    deleteTask: (sessionId, taskId, hostConn) =>
      request(`/sessions/${enc(sessionId)}/tasks/${enc(taskId)}`, { method: "DELETE" }, hostConn),
    createNote: (sessionId, body, hostConn) =>
      request(`/sessions/${enc(sessionId)}/notes`, { method: "POST", body: jsonBody(body) }, hostConn),
    updateNote: (sessionId, noteId, body, hostConn) =>
      request(`/sessions/${enc(sessionId)}/notes/${enc(noteId)}`, {
        method: "PATCH",
        body: jsonBody(body),
      }, hostConn),
    deleteNote: (sessionId, noteId, hostConn) =>
      request(`/sessions/${enc(sessionId)}/notes/${enc(noteId)}`, { method: "DELETE" }, hostConn),

    attachGrok: (body, hostConn) => request("/sessions/attach", { method: "POST", body: jsonBody(body) }, hostConn),
    attachClaude: (body, hostConn) =>
      request("/sessions/attach-claude", { method: "POST", body: jsonBody(body) }, hostConn),
    attachAgy: (body, hostConn) =>
      request("/sessions/attach-agy", { method: "POST", body: jsonBody(body) }, hostConn),

    listBots: (hostConn) => request("/bots", {}, hostConn),
    getBot: (id, hostConn) => request(`/bots/${enc(id)}`, {}, hostConn),
    createBot: (body, hostConn) => request("/bots", { method: "POST", body: jsonBody(body) }, hostConn),
    updateBot: (id, patch, hostConn) =>
      request(`/bots/${enc(id)}`, { method: "PATCH", body: jsonBody(patch) }, hostConn),
    runBot: (id, body = {}, hostConn) =>
      request(`/bots/${enc(id)}/run`, { method: "POST", body: jsonBody(body) }, hostConn),
    getBotOutbox: (id, hostConn) => request(`/bots/${enc(id)}/outbox`, {}, hostConn),
  };

  /**
   * Return a facade that binds every call to `hostConn`. Callers that know
   * which host owns the entity (via `session.hostId`, `bot.hostId`, etc.)
   * use `Api.forHost(hostConnFor(hostId))` and then call methods without
   * threading `hostConn` through every arg list.
   */
  function forHost(hostConn) {
    const bound = { setConnection, getConnection, forHost };
    for (const name of Object.keys(methods)) {
      const fn = methods[name];
      if (typeof fn !== "function") continue;
      if (name === "setConnection" || name === "getConnection") continue;
      // Each method's last param is always `hostConn`; splice it in.
      bound[name] = (...args) => fn(...args, hostConn);
    }
    return bound;
  }

  return { ...methods, forHost };
})();
