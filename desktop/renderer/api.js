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

  function enc(id) {
    return encodeURIComponent(id);
  }

  async function request(path, opts = {}) {
    if (!token) throw new Error("No host token — start the host or set a token in Desktop settings");
    const url = new URL(path, hostURL + "/");
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    };
    if (opts.body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, { ...opts, headers });
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

  async function requestRaw(path) {
    if (!token) throw new Error("No host token — start the host or set a token in Desktop settings");
    const url = new URL(path, hostURL + "/");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
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

  return {
    setConnection,
    getConnection,
    request,
    requestRaw,
    validate: () => request("/auth/validate", { method: "POST", body: "{}" }),
    health: async () => {
      const res = await fetch(`${hostURL}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },

    sessions: (query) => {
      const q = String(query || "").trim();
      return request(q ? `/sessions?q=${encodeURIComponent(q)}` : "/sessions");
    },
    session: (id) => request(`/sessions/${enc(id)}`),
    events: (id, since = 0) =>
      request(`/sessions/${enc(id)}/events?since=${encodeURIComponent(since)}`),
    diff: (id) => request(`/sessions/${enc(id)}/diff`),
    sessionFiles: (id) => request(`/sessions/${enc(id)}/files`),
    sessionFile: (id, filePath) =>
      request(`/sessions/${enc(id)}/file?path=${encodeURIComponent(filePath)}`),
    addExtraDirs: (id, extraDirs) =>
      request(`/sessions/${enc(id)}/extra-dirs`, {
        method: "PATCH",
        body: jsonBody({ extraDirs }),
      }),

    projects: () => request("/projects"),
    project: (id) => request(`/projects/${enc(id)}`),
    createProject: (body) => request("/projects", { method: "POST", body: jsonBody(body) }),
    updateProject: (id, body) =>
      request(`/projects/${enc(id)}`, { method: "PATCH", body: jsonBody(body) }),
    deleteProject: (id, hard = false) =>
      request(`/projects/${enc(id)}${hard ? "?hard=1" : ""}`, { method: "DELETE" }),
    discoverProjects: () => request("/projects/discover", { method: "POST", body: "{}" }),
    uploadProjectAttachment: (projectId, body) =>
      request(`/projects/${enc(projectId)}/attachments`, {
        method: "POST",
        body: jsonBody(body),
      }),
    fetchProjectAttachment: (projectId, attachmentId) =>
      requestRaw(`/projects/${enc(projectId)}/attachments/${enc(attachmentId)}`),
    deleteProjectAttachment: (projectId, attachmentId) =>
      request(`/projects/${enc(projectId)}/attachments/${enc(attachmentId)}`, {
        method: "DELETE",
      }),

    profiles: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.usage) params.set("usage", "1");
      if (opts.admin) params.set("admin", "1");
      const qs = params.toString();
      return request(qs ? `/profiles?${qs}` : "/profiles");
    },
    loginProfile: (id, body = {}) =>
      request(`/profiles/${enc(id)}/login`, { method: "POST", body: jsonBody(body) }),
    createProfile: (body) =>
      request("/profiles", { method: "POST", body: jsonBody(body) }),
    updateProfile: (id, body) =>
      request(`/profiles/${enc(id)}`, { method: "PATCH", body: jsonBody(body) }),
    deleteProfile: (id) =>
      request(`/profiles/${enc(id)}`, { method: "DELETE" }),

    dispatch: (body) => request("/dispatch", { method: "POST", body: jsonBody(body) }),
    toolCall: (sessionId, toolCallId) =>
      request(`/sessions/${enc(sessionId)}/tool-calls/${enc(toolCallId)}`),
    prompt: (id, body) =>
      request(`/sessions/${enc(id)}/prompt`, { method: "POST", body: jsonBody(body) }),
    approve: (id, body) =>
      request(`/sessions/${enc(id)}/approve`, { method: "POST", body: jsonBody(body) }),
    reject: (id, body) =>
      request(`/sessions/${enc(id)}/reject`, { method: "POST", body: jsonBody(body) }),
    answer: (id, body) =>
      request(`/sessions/${enc(id)}/answer-questions`, {
        method: "POST",
        body: jsonBody(body),
      }),
    archive: (id) => request(`/sessions/${enc(id)}/archive`, { method: "POST", body: "{}" }),
    unarchive: (id) =>
      request(`/sessions/${enc(id)}/unarchive`, { method: "POST", body: "{}" }),
    cancel: (id) => request(`/sessions/${enc(id)}/cancel`, { method: "POST", body: "{}" }),
    close: (id) => request(`/sessions/${enc(id)}/close`, { method: "POST", body: "{}" }),
    deleteSession: (id) => request(`/sessions/${enc(id)}`, { method: "DELETE" }),
    renameSession: (id, title) =>
      request(`/sessions/${enc(id)}/title`, { method: "POST", body: jsonBody({ title }) }),
    transferSession: (id, profileId) =>
      request(`/sessions/${enc(id)}/transfer`, {
        method: "POST",
        body: jsonBody({ profileId }),
      }),
    reincarnateSession: (id, body = {}) =>
      request(`/sessions/${enc(id)}/reincarnate`, { method: "POST", body: jsonBody(body) }),
    reviewSession: (id, body = {}) =>
      request(`/sessions/${enc(id)}/review`, { method: "POST", body: jsonBody(body) }),
    setSessionProject: (id, projectId) =>
      request(`/sessions/${enc(id)}/project`, {
        method: "POST",
        body: jsonBody({ projectId: projectId || null }),
      }),

    listTasks: (status) => {
      const q = status ? `?status=${encodeURIComponent(status)}` : "";
      return request(`/tasks${q}`);
    },
    createTask: (sessionId, body) =>
      request(`/sessions/${enc(sessionId)}/tasks`, { method: "POST", body: jsonBody(body) }),
    updateTask: (sessionId, taskId, body) =>
      request(`/sessions/${enc(sessionId)}/tasks/${enc(taskId)}`, {
        method: "PATCH",
        body: jsonBody(body),
      }),
    deleteTask: (sessionId, taskId) =>
      request(`/sessions/${enc(sessionId)}/tasks/${enc(taskId)}`, { method: "DELETE" }),
    createNote: (sessionId, body) =>
      request(`/sessions/${enc(sessionId)}/notes`, { method: "POST", body: jsonBody(body) }),
    updateNote: (sessionId, noteId, body) =>
      request(`/sessions/${enc(sessionId)}/notes/${enc(noteId)}`, {
        method: "PATCH",
        body: jsonBody(body),
      }),
    deleteNote: (sessionId, noteId) =>
      request(`/sessions/${enc(sessionId)}/notes/${enc(noteId)}`, { method: "DELETE" }),

    attachGrok: (body) => request("/sessions/attach", { method: "POST", body: jsonBody(body) }),
    attachClaude: (body) =>
      request("/sessions/attach-claude", { method: "POST", body: jsonBody(body) }),
    attachAgy: (body) =>
      request("/sessions/attach-agy", { method: "POST", body: jsonBody(body) }),

    listBots: () => request("/bots"),
    getBot: (id) => request(`/bots/${enc(id)}`),
    createBot: (body) => request("/bots", { method: "POST", body: jsonBody(body) }),
    updateBot: (id, patch) =>
      request(`/bots/${enc(id)}`, { method: "PATCH", body: jsonBody(patch) }),
    runBot: (id, body = {}) =>
      request(`/bots/${enc(id)}/run`, { method: "POST", body: jsonBody(body) }),
    getBotOutbox: (id) => request(`/bots/${enc(id)}/outbox`),
  };
})();
