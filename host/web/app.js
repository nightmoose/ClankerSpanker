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
  profiles: [],
  profileId: null,
  detail: null,
  token: localStorage.getItem(STORAGE_TOKEN) || "",
  // When served from /app/, same origin is the host
  baseURL: localStorage.getItem(STORAGE_URL) || window.location.origin,
  ws: null,
  connected: false,
  // Profiles admin (Profiles tab). Populated by GET /profiles?admin=1
  // when the browser is talking to the host over loopback.
  admin: false,
  adminProfiles: [],
  profileEditor: null,
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
  ["list", "detail", "compose", "profiles", "settings"].forEach((v) => {
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
    const all = state.showArchived ? state.archived : state.sessions;
    const rows = state.profileId
      ? all.filter((s) => s.profileId === state.profileId || (!s.profileId && state.profiles.find((p) => p.id === state.profileId && p.backend === (s.backend || "grok"))))
      : all;
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

async function renderCompose() {
  const root = $("#view-compose");
  const profile = state.profiles.find((p) => p.id === state.profileId);
  const isBot = profile?.backend === "bot";
  const opts = state.projects
    .map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)} — ${escapeHtml(p.path)}</option>`)
    .join("");
  root.innerHTML = `
    <div class="card">
      <h3>Dispatch a task</h3>
      ${isBot ? `<p class="preview">Hunter bot — this becomes a normal session. Review the transcript and approve outbound drafts there. Nothing is sent.</p>` : ""}
      <label class="field">Project</label>
      <select id="c-project">${opts || `<option value="">(configure projects on host)</option>`}</select>
      <label class="field">Title (optional)</label>
      <input id="c-title" placeholder="Short name" />
      <label class="field">Prompt</label>
      <textarea id="c-prompt" placeholder="What should the agent do?"></textarea>
      ${
        isBot
          ? ""
          : `<label class="field"><input type="checkbox" id="c-plan" checked /> Plan mode</label>
      <label class="field"><input type="checkbox" id="c-wt" checked /> Worktree</label>`
      }
      <button type="button" class="primary" id="c-go" style="width:100%;margin-top:12px">Spank a clanker</button>
    </div>`;
  if (isBot) {
    try {
      const res = await api("/bots");
      const bot =
        (res.bots || []).find((b) => b.profileId === state.profileId) || (res.bots || [])[0];
      if (bot) {
        const ta = $("#c-prompt");
        if (ta && !ta.value.trim()) ta.value = bot.job;
        const sel = $("#c-project");
        if (sel && [...sel.options].some((o) => o.value === bot.projectId)) sel.value = bot.projectId;
      }
    } catch {
      /* optional */
    }
  }
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
          planMode: $("#c-plan")?.checked ?? false,
          worktree: $("#c-wt")?.checked ?? false,
          subagents: true,
          profileId: state.profileId || undefined,
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

// ——— Profiles manager (loopback only) ———

const BACKEND_LABEL = {
  grok: "Grok (xAI ACP)",
  claude: "Claude Code",
  antigravity: "Gemini (Antigravity CLI)",
  bot: "Bot (autonomous)",
};
const BACKEND_OPTIONS = ["grok", "claude", "antigravity", "bot"];
const DEFAULT_COLOR_BY_BACKEND = {
  grok: "#73B8FF",
  claude: "#F97316",
  antigravity: "#34A853",
  bot: "#E879F9",
};

function renderProfiles() {
  showView("profiles");
  const root = $("#view-profiles");

  if (!state.token) {
    root.innerHTML = `<div class="list-empty">Connect in Settings to load profiles.</div>`;
    return;
  }
  if (!state.admin) {
    const localApp = `http://127.0.0.1:${window.location.port || 8787}/app/`;
    root.innerHTML = `
      <div class="card">
        <h3>Profiles manager</h3>
        <p class="preview">You're connected from another device, so create/edit is locked
          (API keys must stay on the host). On the Mac running the gateway, open the
          <strong>Host</strong> toolbar panel or this page locally:</p>
        <p class="preview"><a href="${escapeAttr(localApp)}">${escapeHtml(localApp)}</a></p>
        <p class="preview">Read-only view of configured profiles:</p>
        <div class="profile-list">${(state.profiles || [])
          .map(
            (p) => `
          <div class="profile-row">
            <span class="profile-dot" style="background:${escapeAttr(p.color || "#73B8FF")}"></span>
            <div class="profile-meta">
              <div><strong>${escapeHtml(p.name)}</strong>
                <span class="pill muted">${escapeHtml(BACKEND_LABEL[p.backend] || p.backend)}</span>
                ${p.hasCredentials ? '<span class="pill ok">ready</span>' : '<span class="pill warn">no creds</span>'}
              </div>
              <div class="meta">${escapeHtml(p.id)}${p.model ? ` · ${escapeHtml(p.model)}` : ""}</div>
            </div>
          </div>`,
          )
          .join("")}</div>
      </div>`;
    return;
  }

  const rows = (state.adminProfiles || [])
    .map((p) => {
      const publ = (state.profiles || []).find((x) => x.id === p.id) || {};
      const badges = [
        `<span class="pill muted">${escapeHtml(BACKEND_LABEL[p.backend] || p.backend)}</span>`,
        publ.hasCredentials
          ? '<span class="pill ok">ready</span>'
          : '<span class="pill warn">no creds</span>',
      ];
      const configDir =
        p.backend === "claude"
          ? p.claudeConfigDir
          : p.backend === "antigravity"
            ? p.antigravityConfigDir
            : null;
      const envCount = p.env ? Object.keys(p.env).filter((k) => k.trim()).length : 0;
      const canLogin = p.backend === "claude";
      return `
        <div class="profile-row">
          <span class="profile-dot" style="background:${escapeAttr(p.color || "#73B8FF")}"></span>
          <div class="profile-meta">
            <div><strong>${escapeHtml(p.name)}</strong> ${badges.join(" ")}</div>
            <div class="meta">
              <span>${escapeHtml(p.id)}</span>
              ${p.model ? `<span>model: ${escapeHtml(p.model)}</span>` : ""}
              ${configDir ? `<span>dir: ${escapeHtml(shortPath(configDir))}</span>` : ""}
              ${envCount ? `<span>env: ${envCount}</span>` : ""}
            </div>
          </div>
          <div class="row-actions">
            ${canLogin ? `<button type="button" class="secondary" data-login="${escapeAttr(p.id)}">Login</button>` : ""}
            <button type="button" class="secondary" data-edit="${escapeAttr(p.id)}">Edit</button>
            <button type="button" class="danger" data-delete="${escapeAttr(p.id)}">Delete</button>
          </div>
        </div>`;
    })
    .join("");

  root.innerHTML = `
    <div class="card">
      <div class="row">
        <div>
          <h3>Profiles</h3>
          <p class="preview">Local admin — creds and config paths edit through this pane and get written to <code>~/.grok-dispatch/config.json</code>. Restart the host to pick up new profiles.</p>
        </div>
        <div class="row-actions">
          <button type="button" class="primary" id="btn-new-profile">Add profile</button>
        </div>
      </div>
      <div class="profile-list">${rows || '<p class="preview">No profiles yet.</p>'}</div>
    </div>
    <div id="profile-editor"></div>`;

  root.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => openProfileEditor(btn.getAttribute("data-edit"))),
  );
  root.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => deleteProfile(btn.getAttribute("data-delete"))),
  );
  root.querySelectorAll("[data-login]").forEach((btn) =>
    btn.addEventListener("click", () => loginProfile(btn.getAttribute("data-login"))),
  );
  $("#btn-new-profile")?.addEventListener("click", () => openProfileEditor(null));

  if (state.profileEditor) openProfileEditor(state.profileEditor.id, state.profileEditor.draft);
}

function openProfileEditor(id, draftOverride) {
  const isNew = !id;
  const source = isNew
    ? {
        id: "",
        name: "",
        backend: "grok",
        color: DEFAULT_COLOR_BY_BACKEND.grok,
        model: "",
        systemPrompt: "",
        claudeConfigDir: "",
        antigravityConfigDir: "",
        env: {},
      }
    : (state.adminProfiles || []).find((p) => p.id === id);
  if (!isNew && !source) return;
  const draft = draftOverride || {
    id: source.id || "",
    name: source.name || "",
    backend: source.backend || "grok",
    color: source.color || DEFAULT_COLOR_BY_BACKEND[source.backend] || "#73B8FF",
    model: source.model || "",
    systemPrompt: source.systemPrompt || "",
    claudeConfigDir: source.claudeConfigDir || "",
    antigravityConfigDir: source.antigravityConfigDir || "",
    envText: envToText(source.env || {}),
  };
  state.profileEditor = { id: id || null, draft };

  const dir =
    draft.backend === "claude"
      ? { label: "Claude config dir", key: "claudeConfigDir", hint: "Sets CLAUDE_CONFIG_DIR for this profile so a second Claude account uses its own OAuth store. Leave blank for the default ~/.claude." }
      : draft.backend === "antigravity"
        ? { label: "Antigravity config dir", key: "antigravityConfigDir", hint: "Reserved for multi-account isolation once the agy CLI supports it — today it still uses the global ~/.gemini keyring." }
        : null;

  const envHint =
    draft.backend === "claude"
      ? "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (leave blank to use interactive Claude login)."
      : draft.backend === "antigravity"
        ? "GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY (or leave blank and run `agy` on the host to sign in)."
        : draft.backend === "bot"
          ? "One of XAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY + OPENAI_BASE_URL."
          : "XAI_API_KEY (or leave blank to use the local `grok` CLI login at ~/.grok/auth.json).";

  const host = $("#profile-editor");
  host.innerHTML = `
    <div class="card">
      <h3>${isNew ? "New profile" : `Edit ${escapeHtml(source.name)}`}</h3>
      <label class="field">Name</label>
      <input id="pe-name" value="${escapeAttr(draft.name)}" placeholder="e.g. Work Claude" />
      ${isNew
        ? `<label class="field">Id (slug — leave blank to derive from name)</label>
           <input id="pe-id" value="${escapeAttr(draft.id)}" placeholder="auto" />`
        : ""}
      <label class="field">Backend</label>
      <select id="pe-backend">${BACKEND_OPTIONS.map(
        (b) => `<option value="${b}" ${b === draft.backend ? "selected" : ""}>${escapeHtml(BACKEND_LABEL[b])}</option>`,
      ).join("")}</select>
      <label class="field">Color (hex or name)</label>
      <input id="pe-color" value="${escapeAttr(draft.color)}" />
      <label class="field">Model (leave blank for CLI default)</label>
      <input id="pe-model" value="${escapeAttr(draft.model)}" placeholder="e.g. claude, grok-4, gemini-3.5-flash-medium" />
      ${dir
        ? `<label class="field">${escapeHtml(dir.label)}</label>
           <input id="pe-configdir" value="${escapeAttr(draft[dir.key])}" placeholder="~/.claude-work" />
           <p class="preview">${escapeHtml(dir.hint)}</p>`
        : ""}
      <label class="field">Environment (KEY=VALUE per line, secrets stay on this machine)</label>
      <textarea id="pe-env" rows="4" spellcheck="false" placeholder="ANTHROPIC_API_KEY=sk-...">${escapeHtml(draft.envText)}</textarea>
      <p class="preview">${escapeHtml(envHint)}</p>
      <label class="field">System prompt (Claude persona — appended)</label>
      <textarea id="pe-sysprompt" rows="3">${escapeHtml(draft.systemPrompt)}</textarea>
      <div class="row-actions" style="margin-top:12px;justify-content:flex-end">
        <button type="button" class="secondary" id="pe-cancel">Cancel</button>
        <button type="button" class="primary" id="pe-save">${isNew ? "Create profile" : "Save changes"}</button>
      </div>
    </div>`;

  const readDraft = () => ({
    id: isNew ? ($("#pe-id")?.value.trim() || "") : source.id,
    name: $("#pe-name").value.trim(),
    backend: $("#pe-backend").value,
    color: $("#pe-color").value.trim(),
    model: $("#pe-model").value.trim(),
    systemPrompt: $("#pe-sysprompt").value.trim(),
    claudeConfigDir: dir?.key === "claudeConfigDir" ? $("#pe-configdir")?.value.trim() : source.claudeConfigDir || "",
    antigravityConfigDir: dir?.key === "antigravityConfigDir" ? $("#pe-configdir")?.value.trim() : source.antigravityConfigDir || "",
    envText: $("#pe-env").value,
  });

  $("#pe-backend").addEventListener("change", () => {
    const next = readDraft();
    // Snap color to default if user hasn't customized off the previous backend default
    const prevDefault = DEFAULT_COLOR_BY_BACKEND[draft.backend];
    if (!next.color || next.color.toLowerCase() === prevDefault?.toLowerCase()) {
      next.color = DEFAULT_COLOR_BY_BACKEND[next.backend] || next.color;
    }
    openProfileEditor(id, next);
  });
  $("#pe-cancel").addEventListener("click", () => {
    state.profileEditor = null;
    renderProfiles();
  });
  $("#pe-save").addEventListener("click", async () => {
    const d = readDraft();
    if (!d.name) {
      banner("Name is required", true);
      return;
    }
    const env = envFromText(d.envText);
    const payload = {
      name: d.name,
      backend: d.backend,
      color: d.color || DEFAULT_COLOR_BY_BACKEND[d.backend],
      model: d.model || null,
      systemPrompt: d.systemPrompt || null,
      claudeConfigDir: d.claudeConfigDir || null,
      antigravityConfigDir: d.antigravityConfigDir || null,
      env,
    };
    try {
      if (isNew) {
        if (d.id) payload.id = d.id;
        await api("/profiles", { method: "POST", body: JSON.stringify(payload) });
        banner("Profile created — it is live now. Refresh the Mac app if chips don't appear.");
      } else {
        await api(`/profiles/${encodeURIComponent(source.id)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        banner("Profile saved");
      }
      state.profileEditor = null;
      await refresh();
      renderProfiles();
    } catch (e) {
      banner(e.message, true);
    }
  });
}

async function deleteProfile(id) {
  if (!id) return;
  if (!confirm(`Delete profile "${id}"? Config file is updated immediately; running sessions using this profile are refused.`)) return;
  try {
    await api(`/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    banner("Profile deleted");
    if (state.profileEditor?.id === id) state.profileEditor = null;
    await refresh();
    renderProfiles();
  } catch (e) {
    banner(e.message, true);
  }
}

async function loginProfile(id) {
  if (!id) return;
  try {
    const r = await api(`/profiles/${encodeURIComponent(id)}/login`, {
      method: "POST",
      body: "{}",
    });
    banner(r?.message || "Login started — check the host terminal / browser");
  } catch (e) {
    banner(e.message, true);
  }
}

function envToText(env) {
  return Object.entries(env || {})
    .filter(([k]) => k && k.trim())
    .map(([k, v]) => `${k}=${v ?? ""}`)
    .join("\n");
}

function envFromText(text) {
  const out = {};
  String(text || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) return;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1);
      if (k) out[k] = v;
    });
  return out;
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
    const [sessions, projects, profiles] = await Promise.all([
      api("/sessions"),
      api("/projects").catch(() => ({ projects: [] })),
      // Ask for admin payload; server ignores it for non-loopback callers.
      api("/profiles?admin=1").catch(() => ({ profiles: [], admin: false })),
    ]);
    state.sessions = sessions.sessions || [];
    state.archived = sessions.archivedSessions || [];
    state.disk = sessions.diskSessions || [];
    state.claude = sessions.claudeSessions || [];
    state.projects = projects.projects || [];
    state.profiles = profiles.profiles || [];
    state.admin = profiles.admin === true;
    state.adminProfiles = profiles.adminProfiles || [];
    if (!state.profileId && state.profiles[0]) state.profileId = state.profiles[0].id;
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
      } else if (state.tab === "profiles") {
        renderProfiles();
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
