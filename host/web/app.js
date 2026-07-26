/**
 * ClankerSpanker browser control plane — talks to the same host API as the iOS app.
 * Token is stored in localStorage only (this browser).
 */

const STORAGE_TOKEN = "clankerspanker.token";
const STORAGE_URL = "clankerspanker.hostURL";

const state = {
  tab: "active",
  showArchived: false,
  sessions: [],
  archived: [],
  disk: [],
  claude: [],
  projects: [],
  detail: null,
  token: localStorage.getItem(STORAGE_TOKEN) || "",
  // When served from /app/, same origin is the host
  baseURL: localStorage.getItem(STORAGE_URL) || window.location.origin,
  ws: null,
  connected: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function banner(msg, isError = false) {
  const el = $("#banner");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(banner._t);
  banner._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${state.token}`,
    "Content-Type": "application/json",
  };
}

async function api(path, opts = {}) {
  const url = new URL(path, state.baseURL.replace(/\/$/, "") + "/");
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
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

function setConn(ok) {
  state.connected = ok;
  const el = $("#conn");
  el.textContent = ok ? "live" : "offline";
  el.classList.toggle("ok", ok);
  el.classList.toggle("muted", !ok);
}

function showView(name) {
  ["list", "detail", "compose", "settings"].forEach((v) => {
    $(`#view-${v}`)?.classList.toggle("hidden", v !== name);
  });
}

function statusClass(s) {
  return `status ${String(s || "").replace(/[^a-z_]/g, "")}`;
}

// ——— Renderers ———

function renderList() {
  const root = $("#view-list");
  if (!state.token) {
    root.innerHTML = `<div class="list-empty">Connect in Settings to load sessions.</div>`;
    return;
  }

  if (state.tab === "compose") {
    showView("compose");
    renderCompose();
    return;
  }
  showView("list");

  if (state.tab === "active") {
    const rows = state.showArchived ? state.archived : state.sessions;
    const title = state.showArchived ? "Archived" : "Active";
    if (!rows.length) {
      root.innerHTML = `<div class="list-empty">No ${title.toLowerCase()} chats.<br/><span style="font-size:13px">Compose a task or open Grok/Claude from disk.</span></div>`;
      return;
    }
    root.innerHTML = rows.map(sessionCard).join("");
    root.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", () => openSession(el.getAttribute("data-open")));
    });
    root.querySelectorAll("[data-archive]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = el.getAttribute("data-archive");
        try {
          await api(`/sessions/${id}/archive`, { method: "POST", body: "{}" });
          banner("Archived");
          await refresh();
        } catch (err) {
          banner(err.message, true);
        }
      });
    });
    root.querySelectorAll("[data-unarchive]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = el.getAttribute("data-unarchive");
        try {
          await api(`/sessions/${id}/unarchive`, { method: "POST", body: "{}" });
          banner("Restored to inbox");
          await refresh();
        } catch (err) {
          banner(err.message, true);
        }
      });
    });
    return;
  }

  if (state.tab === "grok") {
    root.innerHTML = state.disk.length
      ? state.disk.map((d) => diskCard(d, "grok")).join("")
      : `<div class="list-empty">No Grok sessions on disk.</div>`;
    wireDiskButtons(root);
    return;
  }

  if (state.tab === "claude") {
    root.innerHTML = state.claude.length
      ? state.claude.map((d) => diskCard(d, "claude")).join("")
      : `<div class="list-empty">No Claude sessions on disk.</div>`;
    wireDiskButtons(root);
  }
}

function sessionCard(s) {
  const archived = state.showArchived;
  return `
    <article class="card">
      <div class="row">
        <div data-open="${s.id}" style="cursor:pointer;flex:1;min-width:0">
          <h3>${escapeHtml(s.title || "Session")}</h3>
          <div class="meta">
            <span class="${statusClass(s.status)}">${escapeHtml(s.status)}</span>
            <span>${escapeHtml(s.model || "")}</span>
            <span>${escapeHtml(shortPath(s.cwd))}</span>
          </div>
          <div class="preview">${escapeHtml(s.transcriptPreview || s.prompt || "")}</div>
        </div>
        <div class="row-actions">
          ${
            archived
              ? `<button type="button" class="secondary" data-unarchive="${s.id}" title="Unarchive">↩</button>`
              : `<button type="button" class="secondary" data-archive="${s.id}" title="Archive">📦</button>`
          }
        </div>
      </div>
    </article>`;
}

function diskCard(d, kind) {
  return `
    <article class="card">
      <div class="row">
        <div style="flex:1;min-width:0">
          <h3>${escapeHtml(d.title || d.id.slice(0, 8))}</h3>
          <div class="meta">
            <span>${kind === "claude" ? "Claude" : "Grok"}</span>
            <span>${escapeHtml(shortPath(d.cwd || ""))}</span>
          </div>
        </div>
        <div class="row-actions">
          ${
            kind === "claude"
              ? `<button type="button" class="primary" data-attach-claude="${d.id}" data-cwd="${escapeAttr(d.cwd || "")}" data-title="${escapeAttr(d.title || "")}" data-path="${escapeAttr(d.transcriptPath || "")}">Resume</button>
                 <button type="button" class="secondary" data-attach-claude-grok="${d.id}" data-cwd="${escapeAttr(d.cwd || "")}" data-title="${escapeAttr(d.title || "")}" data-path="${escapeAttr(d.transcriptPath || "")}">→ Grok</button>`
              : `<button type="button" class="primary" data-attach-grok="${d.id}" data-cwd="${escapeAttr(d.cwd || "")}" data-title="${escapeAttr(d.title || "")}">Open</button>`
          }
        </div>
      </div>
    </article>`;
}

function wireDiskButtons(root) {
  root.querySelectorAll("[data-attach-grok]").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        const detail = await api("/sessions/attach", {
          method: "POST",
          body: JSON.stringify({
            grokSessionId: el.getAttribute("data-attach-grok"),
            cwd: el.getAttribute("data-cwd"),
            title: el.getAttribute("data-title") || undefined,
          }),
        });
        banner("Attached Grok session");
        await refresh();
        openSession(detail.id);
      } catch (err) {
        banner(err.message, true);
      }
    });
  });
  root.querySelectorAll("[data-attach-claude]").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        const detail = await api("/sessions/attach-claude", {
          method: "POST",
          body: JSON.stringify({
            claudeSessionId: el.getAttribute("data-attach-claude"),
            cwd: el.getAttribute("data-cwd"),
            title: el.getAttribute("data-title") || undefined,
            mode: "resume-claude",
            transcriptPath: el.getAttribute("data-path") || undefined,
          }),
        });
        banner("Resumed Claude session");
        await refresh();
        openSession(detail.id);
      } catch (err) {
        banner(err.message, true);
      }
    });
  });
  root.querySelectorAll("[data-attach-claude-grok]").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        const detail = await api("/sessions/attach-claude", {
          method: "POST",
          body: JSON.stringify({
            claudeSessionId: el.getAttribute("data-attach-claude-grok"),
            cwd: el.getAttribute("data-cwd"),
            title: el.getAttribute("data-title") || undefined,
            mode: "continue-with-grok",
            transcriptPath: el.getAttribute("data-path") || undefined,
          }),
        });
        banner("Continued with Grok");
        await refresh();
        openSession(detail.id);
      } catch (err) {
        banner(err.message, true);
      }
    });
  });
}

async function openSession(id) {
  try {
    state.detail = await api(`/sessions/${id}`);
    renderDetail();
    showView("detail");
  } catch (err) {
    banner(err.message, true);
  }
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const root = $("#view-detail");
  const transcript = [...(d.transcript || [])].reverse();
  const pendingA = d.pendingApproval;
  const pendingQ = d.pendingQuestion;

  root.innerHTML = `
    <div class="row">
      <button type="button" class="secondary" id="back-list">← Back</button>
      <div class="row-actions">
        ${d.archived ? `<button type="button" class="secondary" id="btn-unarch">Unarchive</button>` : `<button type="button" class="secondary" id="btn-arch">Archive</button>`}
        <button type="button" class="danger" id="btn-cancel">Cancel</button>
      </div>
    </div>
    <div class="card">
      <h3>${escapeHtml(d.title)}</h3>
      <div class="meta">
        <span class="${statusClass(d.status)}">${escapeHtml(d.status)}</span>
        <span>${escapeHtml(d.model)}</span>
        <span>${escapeHtml(shortPath(d.cwd))}</span>
      </div>
      ${d.error ? `<p class="preview" style="color:var(--danger)">${escapeHtml(d.error)}</p>` : ""}
    </div>
    <div class="transcript">
      ${transcript.map((t) => `
        <div class="bubble ${t.role === "user" ? "user" : ""}">
          <div class="role">${escapeHtml(t.role)}</div>
          <div class="text">${escapeHtml(t.text || "")}</div>
        </div>`).join("")}
    </div>
    ${
      pendingA
        ? `<div class="approval">
            <strong>${escapeHtml(pendingA.title || "Approval needed")}</strong>
            <p class="preview">${escapeHtml(pendingA.kind || "")}</p>
            <div class="row-actions" style="margin-top:10px">
              <button type="button" class="primary" id="btn-approve">Approve</button>
              <button type="button" class="danger" id="btn-reject">Reject</button>
            </div>
          </div>`
        : ""
    }
    ${
      pendingQ
        ? `<div class="question">
            <strong>${escapeHtml(pendingQ.title || "Questions")}</strong>
            ${(pendingQ.questions || [])
              .map(
                (q, i) => `
              <label class="field">Q${i + 1}. ${escapeHtml(q.question)}</label>
              <select data-q="${i}">
                ${(q.options || []).map((o) => `<option value="${escapeAttr(o.label)}">${escapeHtml(o.label)}</option>`).join("")}
              </select>`,
              )
              .join("")}
            <button type="button" class="primary" id="btn-answer" style="margin-top:10px;width:100%">Submit answers</button>
          </div>`
        : ""
    }
    ${
      !pendingA && !pendingQ
        ? `<div class="followup">
            <input id="followup-input" placeholder="Message agent…" />
            <button type="button" class="primary" id="btn-send">Send</button>
          </div>`
        : ""
    }
  `;

  $("#back-list")?.addEventListener("click", () => {
    state.detail = null;
    showView("list");
    renderList();
  });
  $("#btn-arch")?.addEventListener("click", async () => {
    try {
      await api(`/sessions/${d.id}/archive`, { method: "POST", body: "{}" });
      banner("Archived");
      state.detail = null;
      await refresh();
      showView("list");
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-unarch")?.addEventListener("click", async () => {
    try {
      state.detail = await api(`/sessions/${d.id}/unarchive`, { method: "POST", body: "{}" });
      banner("Unarchived");
      renderDetail();
      await refresh();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-cancel")?.addEventListener("click", async () => {
    try {
      state.detail = await api(`/sessions/${d.id}/cancel`, { method: "POST", body: "{}" });
      renderDetail();
      await refresh();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-approve")?.addEventListener("click", async () => {
    try {
      state.detail = await api(`/sessions/${d.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ approvalId: pendingA.id }),
      });
      renderDetail();
      await refresh();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-reject")?.addEventListener("click", async () => {
    try {
      state.detail = await api(`/sessions/${d.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ approvalId: pendingA.id }),
      });
      renderDetail();
      await refresh();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-answer")?.addEventListener("click", async () => {
    const answers = [...root.querySelectorAll("select[data-q]")].map((s) => s.value);
    try {
      state.detail = await api(`/sessions/${d.id}/answer-questions`, {
        method: "POST",
        body: JSON.stringify({ questionId: pendingQ.id, answers }),
      });
      renderDetail();
      await refresh();
    } catch (e) {
      banner(e.message, true);
    }
  });
  const send = async () => {
    const input = $("#followup-input");
    const text = input?.value?.trim();
    if (!text) return;
    try {
      state.detail = await api(`/sessions/${d.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: text }),
      });
      renderDetail();
      await refresh();
    } catch (e) {
      banner(e.message, true);
    }
  };
  $("#btn-send")?.addEventListener("click", send);
  $("#followup-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}

function renderCompose() {
  const root = $("#view-compose");
  const opts = state.projects
    .map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)} — ${escapeHtml(p.path)}</option>`)
    .join("");
  root.innerHTML = `
    <div class="card">
      <h3>Dispatch a task</h3>
      <label class="field">Project</label>
      <select id="c-project">${opts || `<option value="">(configure projects on host)</option>`}</select>
      <label class="field">Title (optional)</label>
      <input id="c-title" placeholder="Short name" />
      <label class="field">Prompt</label>
      <textarea id="c-prompt" placeholder="What should the agent do?"></textarea>
      <label class="field"><input type="checkbox" id="c-plan" checked /> Plan mode</label>
      <label class="field"><input type="checkbox" id="c-wt" checked /> Worktree</label>
      <button type="button" class="primary" id="c-go" style="width:100%;margin-top:12px">Spank a clanker</button>
    </div>`;
  $("#c-go")?.addEventListener("click", async () => {
    const prompt = $("#c-prompt").value.trim();
    if (!prompt) {
      banner("Write a prompt first", true);
      return;
    }
    try {
      const detail = await api("/dispatch", {
        method: "POST",
        body: JSON.stringify({
          prompt,
          projectId: $("#c-project").value || undefined,
          title: $("#c-title").value.trim() || undefined,
          planMode: $("#c-plan").checked,
          worktree: $("#c-wt").checked,
          subagents: true,
        }),
      });
      banner("Dispatched");
      state.tab = "active";
      syncTabs();
      await refresh();
      openSession(detail.id);
    } catch (e) {
      banner(e.message, true);
    }
  });
}

function renderSettings() {
  showView("settings");
  const root = $("#view-settings");
  root.innerHTML = `
    <div class="card">
      <h3>Connection</h3>
      <p class="preview">When this UI is served by the host, Host URL can stay as this origin. Paste the host token from <code>/setup</code>.</p>
      <label class="field">Host URL</label>
      <input id="s-url" value="${escapeAttr(state.baseURL)}" />
      <label class="field">Host token</label>
      <input id="s-token" value="${escapeAttr(state.token)}" autocomplete="off" />
      <button type="button" class="primary" id="s-save" style="width:100%;margin-top:12px">Save &amp; connect</button>
      <button type="button" class="secondary" id="s-clear" style="width:100%;margin-top:8px">Clear token</button>
    </div>`;
  $("#s-save")?.addEventListener("click", async () => {
    state.baseURL = $("#s-url").value.trim().replace(/\/$/, "") || window.location.origin;
    state.token = $("#s-token").value.trim();
    localStorage.setItem(STORAGE_URL, state.baseURL);
    localStorage.setItem(STORAGE_TOKEN, state.token);
    try {
      await api("/auth/validate", { method: "POST", body: "{}" });
      banner("Connected");
      connectWs();
      await refresh();
      state.tab = "active";
      syncTabs();
      showView("list");
      renderList();
    } catch (e) {
      setConn(false);
      banner(e.message, true);
    }
  });
  $("#s-clear")?.addEventListener("click", () => {
    state.token = "";
    localStorage.removeItem(STORAGE_TOKEN);
    $("#s-token").value = "";
    setConn(false);
    banner("Token cleared");
  });
}

// ——— Data / WS ———

async function refresh() {
  if (!state.token) return;
  try {
    const [sessions, projects] = await Promise.all([
      api("/sessions"),
      api("/projects").catch(() => ({ projects: [] })),
    ]);
    state.sessions = sessions.sessions || [];
    state.archived = sessions.archivedSessions || [];
    state.disk = sessions.diskSessions || [];
    state.claude = sessions.claudeSessions || [];
    state.projects = projects.projects || [];
    setConn(true);
    if (!state.detail) renderList();
    else if (state.detail?.id) {
      try {
        state.detail = await api(`/sessions/${state.detail.id}`);
        if (!$("#view-detail").classList.contains("hidden")) renderDetail();
      } catch {
        /* keep list */
      }
    }
  } catch (e) {
    setConn(false);
    banner(e.message, true);
  }
}

function connectWs() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* */
    }
  }
  if (!state.token) return;
  try {
    const u = new URL(state.baseURL);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws";
    u.search = `token=${encodeURIComponent(state.token)}`;
    const ws = new WebSocket(u.toString());
    state.ws = ws;
    ws.onopen = () => setConn(true);
    ws.onclose = () => setConn(false);
    ws.onmessage = () => {
      // Lightweight: refresh list/detail on any event
      refresh();
    };
  } catch {
    /* optional */
  }
}

function syncTabs() {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
  $("#btn-archived")?.classList.toggle("active", state.showArchived);
}

function shortPath(p) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/") || p;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

// ——— Boot ———

function boot() {
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      state.detail = null;
      syncTabs();
      if (state.tab === "compose") {
        showView("compose");
        renderCompose();
      } else if (state.tab === "settings") {
        renderSettings();
      } else {
        renderList();
      }
    });
  });
  $("#btn-refresh")?.addEventListener("click", () => refresh());
  $("#btn-settings")?.addEventListener("click", () => renderSettings());
  $("#btn-archived")?.addEventListener("click", () => {
    state.showArchived = !state.showArchived;
    state.tab = "active";
    syncTabs();
    renderList();
  });

  // Prefer token from ?token= once (setup flow)
  const q = new URLSearchParams(location.search);
  if (q.get("token")) {
    state.token = q.get("token");
    localStorage.setItem(STORAGE_TOKEN, state.token);
    history.replaceState({}, "", location.pathname);
  }

  if (!state.token) {
    renderSettings();
  } else {
    connectWs();
    refresh().then(() => renderList());
  }
}

boot();
