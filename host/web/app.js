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
  mcpCatalog: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function banner(msg, isError = false) {
  const el = $("#banner");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(banner._t);
  banner._t = setTimeout(() => el.classList.add("hidden"), isError ? 10000 : 3500);
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

// RFC-021: per-session Grok credit meter badge. Grok-only; other backends
// (Claude / Antigravity / Bot) never surface a delta. Green < 5%, amber ≥ 5%,
// red ≥ 10%. Tooltip nudges reincarnation once the chat has grown expensive.
function creditBadge(s) {
  const delta = typeof s?.creditsUsedDeltaPct === "number" ? s.creditsUsedDeltaPct : null;
  if (delta == null || !Number.isFinite(delta)) return "";
  const tier = delta >= 10 ? "red" : delta >= 5 ? "amber" : "green";
  const rounded = delta < 1 ? delta.toFixed(1) : Math.round(delta).toString();
  const title =
    tier === "green"
      ? `This chat has burned ${rounded}% of the weekly Grok plan.`
      : `This chat has burned ${rounded}% of the weekly Grok plan. Consider reincarnating.`;
  return `<span class="credit-badge credit-${tier}" title="${escapeAttr(title)}">wk +${rounded}%</span>`;
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
            <span title="${escapeHtml(s.cwd || "")}">${escapeHtml(projectLabel(s))}</span>
            ${s.grokHomeLabel ? `<span class="badge" title="Grok session stored in ${escapeHtml(s.grokHomeLabel)}; it resumes there.">${escapeHtml(s.grokHomeLabel)}</span>` : ""}
            ${creditBadge(s)}
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
            ${approvalPreviewHtml(pendingA.preview)}
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
    .filter((p) => !p.archived)
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
            : p.grokHome;
      const envCount = p.env ? Object.keys(p.env).filter((k) => k.trim()).length : 0;
      const canLogin = p.backend === "claude";
      const mcpNames = (p.mcpServers || []).map((s) => s && s.name).filter(Boolean);
      const assigned = (state.mcpCatalog?.assignments?.[p.id] || []).length;
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
              ${mcpNames.length ? `<span>mcp: ${escapeHtml(mcpNames.join(", "))}</span>` : '<span>mcp: none</span>'}
            </div>
          </div>
          <div class="row-actions">
            ${canLogin ? `<button type="button" class="secondary" data-login="${escapeAttr(p.id)}">Login</button>` : ""}
            ${assigned ? `<button type="button" class="secondary" data-apply-catalog="${escapeAttr(p.id)}">Apply catalog</button>` : ""}
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
  root.querySelectorAll("[data-apply-catalog]").forEach((btn) =>
    btn.addEventListener("click", () => applyCatalogToProfile(btn.getAttribute("data-apply-catalog"))),
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
        grokHome: "",
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
    grokHome: source.grokHome || "",
    envText: envToText(source.env || {}),
    mcpText: mcpToText(source.mcpServers),
  };
  state.profileEditor = { id: id || null, draft };

  const dir =
    draft.backend === "claude"
      ? { label: "Claude config dir", key: "claudeConfigDir", hint: "Sets CLAUDE_CONFIG_DIR for this profile so a second Claude account uses its own OAuth store. Leave blank for the default ~/.claude." }
      : draft.backend === "antigravity"
        ? { label: "Antigravity config dir", key: "antigravityConfigDir", hint: "Reserved for multi-account isolation once the agy CLI supports it — today it still uses the global ~/.gemini keyring." }
        : draft.backend === "grok" || draft.backend === "bot"
          ? { label: "Grok home", key: "grokHome", hint: "Leave blank to use an isolated GROK_HOME under ~/.grok-dispatch/grok-homes (shares this Mac's Grok login, does not inherit Claude's Vercel plugin MCP). Set a path only for a second Grok account." }
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
      ${catalogChipBlock(draft)}
      <label class="field">MCP servers (JSON array — billed to this profile)</label>
      <textarea id="pe-mcp" rows="6" spellcheck="false" placeholder='[{"name":"databricks","command":"npx","args":["-y","databricks-mcp"]}]'>${escapeHtml(draft.mcpText || "")}</textarea>
      <p class="preview">stdio: command/args/env. HTTP: url/headers/transport. Use \${VAR} from Environment above. Secrets stay on this machine. HTTP servers can Sign in with MCP OAuth after you save the profile.</p>
      ${mcpOAuthBlock(isNew ? null : source)}
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
    mcpText: $("#pe-mcp")?.value ?? "",
    claudeConfigDir: dir?.key === "claudeConfigDir" ? $("#pe-configdir")?.value.trim() : (draft.claudeConfigDir || source.claudeConfigDir || ""),
    antigravityConfigDir: dir?.key === "antigravityConfigDir" ? $("#pe-configdir")?.value.trim() : (draft.antigravityConfigDir || source.antigravityConfigDir || ""),
    grokHome: dir?.key === "grokHome" ? $("#pe-configdir")?.value.trim() : (draft.grokHome || source.grokHome || ""),
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
  host.querySelectorAll("[data-mcp-oauth]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-mcp-oauth");
      const action = btn.getAttribute("data-mcp-action");
      if (!name || isNew) return;
      if (action === "logout") logoutMcpOAuth(source.id, name);
      else startMcpOAuth(source.id, name);
    });
  });
  host.querySelectorAll("[data-mcp-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = readDraft();
      try {
        next.mcpText = mcpToText(toggleCatalogServer(parseMcpText(next.mcpText), btn.getAttribute("data-mcp-chip")));
      } catch (err) {
        banner(err instanceof Error ? err.message : String(err), true);
        return;
      }
      openProfileEditor(id, next);
    });
  });
  $("#pe-mcp-apply")?.addEventListener("click", () => {
    const next = readDraft();
    if (!isNew && id) {
      applyCatalogToProfile(id, next);
      return;
    }
    try {
      const profileId = id || next.id || slugHint(next.name);
      next.mcpText = mcpToText(mergeCatalogDefaults(profileId, parseMcpText(next.mcpText)));
      openProfileEditor(id, next);
      banner("Catalog defaults filled in JSON — Save, then Sign in HTTP rows");
    } catch (err) {
      banner(err instanceof Error ? err.message : String(err), true);
    }
  });
  $("#pe-save").addEventListener("click", async () => {
    const d = readDraft();
    if (!d.name) {
      banner("Name is required", true);
      return;
    }
    const env = envFromText(d.envText);
    let mcpServers;
    try {
      mcpServers = parseMcpText(d.mcpText);
    } catch (err) {
      banner(err instanceof Error ? err.message : String(err), true);
      return;
    }
    const payload = {
      name: d.name,
      backend: d.backend,
      color: d.color || DEFAULT_COLOR_BY_BACKEND[d.backend],
      model: d.model || null,
      systemPrompt: d.systemPrompt || null,
      claudeConfigDir: d.claudeConfigDir || null,
      antigravityConfigDir: d.antigravityConfigDir || null,
      grokHome: d.grokHome || null,
      env,
      mcpServers,
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

function headerHasAuthorization(headers) {
  if (!headers || typeof headers !== "object") return false;
  return Object.keys(headers).some(
    (k) => k.toLowerCase() === "authorization" && String(headers[k] || "").trim(),
  );
}

function mcpOAuthBlock(source) {
  if (!source?.id) {
    return `<p class="preview">Save this profile first, then Sign in to HTTP MCP servers.</p>`;
  }
  const servers = (source.mcpServers || []).filter((s) => s && s.url);
  if (!servers.length) return "";
  const status = source.mcpOAuth || {};
  const rows = servers
    .map((s) => {
      if (headerHasAuthorization(s.headers)) {
        return `<div class="mcp-oauth-row">
        <span class="name">${escapeHtml(s.name)}</span>
        <span class="meta">token from Environment — no Sign in</span>
      </div>`;
      }
      const st = status[s.name] || {};
      const connected = st.connected === true;
      const label = connected
        ? st.expiresAt
          ? `signed in · expires ${escapeHtml(String(st.expiresAt).slice(0, 16).replace("T", " "))}`
          : "signed in"
        : st.expired
          ? "expired"
          : "not signed in";
      const action = connected ? "logout" : "start";
      const btn = connected ? "Sign out" : "Sign in";
      return `<div class="mcp-oauth-row">
        <span class="name">${escapeHtml(s.name)}</span>
        <span class="meta">${escapeHtml(label)}</span>
        <button type="button" class="secondary" data-mcp-oauth="${escapeAttr(s.name)}" data-mcp-action="${action}">${btn}</button>
      </div>`;
    })
    .join("");
  return `<div class="mcp-oauth-list">${rows}</div>`;
}

async function startMcpOAuth(profileId, serverName) {
  if (!profileId || !serverName) return;
  const src = (state.adminProfiles || []).find((p) => p.id === profileId);
  const server = (src?.mcpServers || []).find((s) => s && s.name === serverName);
  if (headerHasAuthorization(server?.headers)) {
    banner(`${serverName} already uses a token from Environment — no Sign in`, true);
    return;
  }
  // Open the tab in the click gesture. Discovery/DCR can take seconds, and
  // window.open after await is treated as a popup and silently blocked.
  const popup = window.open("about:blank", `mcp-oauth-${profileId}-${serverName}`);
  try {
    const r = await api(
      `/profiles/${encodeURIComponent(profileId)}/mcp/${encodeURIComponent(serverName)}/oauth/start`,
      { method: "POST", body: "{}" },
    );
    if (r?.authorizeUrl) {
      if (popup && !popup.closed) {
        popup.location.replace(r.authorizeUrl);
      } else {
        banner(`Popup blocked — click Open ${serverName} sign-in`, true);
      }
      const row = document.querySelector(`[data-mcp-oauth="${CSS.escape(serverName)}"]`)?.closest(".mcp-oauth-row");
      if (row && !row.querySelector("[data-mcp-open]")) {
        const a = document.createElement("a");
        a.className = "secondary";
        a.href = r.authorizeUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.setAttribute("data-mcp-open", serverName);
        a.textContent = "Open sign-in";
        a.style.cssText = "display:inline-block;padding:8px 12px;border-radius:8px;text-decoration:none";
        row.appendChild(a);
      }
      banner(`Complete ${serverName} sign-in in the browser tab`);
      pollMcpOAuth(profileId, serverName);
    } else {
      popup?.close();
    }
  } catch (e) {
    try {
      popup?.close();
    } catch {
      /* */
    }
    banner(e.message, true);
  }
}

async function logoutMcpOAuth(profileId, serverName) {
  if (!profileId || !serverName) return;
  try {
    await api(
      `/profiles/${encodeURIComponent(profileId)}/mcp/${encodeURIComponent(serverName)}/oauth/logout`,
      { method: "POST", body: "{}" },
    );
    banner(`Signed out of ${serverName}`);
    const draft = state.profileEditor?.draft;
    await refresh();
    if (state.profileEditor?.id === profileId) openProfileEditor(profileId, draft);
  } catch (e) {
    banner(e.message, true);
  }
}

async function pollMcpOAuth(profileId, serverName) {
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await refresh();
    } catch {
      continue;
    }
    const p = (state.adminProfiles || []).find((x) => x.id === profileId);
    if (p?.mcpOAuth?.[serverName]?.connected) {
      banner(`Signed in to ${serverName}`);
      if (state.profileEditor?.id === profileId) {
        openProfileEditor(profileId, state.profileEditor.draft);
      } else {
        renderProfiles();
      }
      return;
    }
  }
}

function mcpToText(servers) {
  if (!Array.isArray(servers) || !servers.length) return "";
  try {
    return JSON.stringify(servers, null, 2);
  } catch {
    return "";
  }
}

function parseMcpText(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    throw new Error("MCP servers must be valid JSON");
  }
  if (!Array.isArray(v)) throw new Error("MCP servers must be a JSON array");
  return v;
}

function slugHint(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function catalogServerPayload(id) {
  const s = (state.mcpCatalog?.servers || []).find((x) => x.id === id);
  if (!s) return null;
  const entry = { name: s.id, transport: s.transport || (s.url ? "http" : "stdio") };
  if (s.url) entry.url = s.url;
  if (s.command) entry.command = s.command;
  if (Array.isArray(s.args) && s.args.length) entry.args = s.args;
  if (s.env && typeof s.env === "object") entry.env = s.env;
  if (s.headers && typeof s.headers === "object") entry.headers = s.headers;
  if (s.id === "github" && !headerHasAuthorization(entry.headers)) {
    entry.headers = { ...(entry.headers || {}), Authorization: "Bearer ${GITHUB_TOKEN}" };
  }
  return entry;
}

function toggleCatalogServer(servers, id) {
  const name = String(id || "").trim();
  if (!name) return servers;
  const list = Array.isArray(servers) ? [...servers] : [];
  const idx = list.findIndex((s) => s && s.name === name);
  if (idx >= 0) {
    list.splice(idx, 1);
    return list;
  }
  const entry = catalogServerPayload(name);
  if (!entry) throw new Error(`Unknown catalog server "${name}"`);
  list.push(entry);
  return list;
}

function mergeCatalogDefaults(profileId, existing) {
  const ids = state.mcpCatalog?.assignments?.[profileId] || [];
  const list = Array.isArray(existing) ? [...existing] : [];
  const have = new Set(list.map((s) => s && s.name).filter(Boolean));
  for (const id of ids) {
    if (have.has(id)) continue;
    const entry = catalogServerPayload(id);
    if (entry) {
      list.push(entry);
      have.add(id);
    }
  }
  return list;
}

function catalogChipBlock(draft) {
  const servers = state.mcpCatalog?.servers || [];
  if (!servers.length) return "";
  let current = new Set();
  try {
    parseMcpText(draft.mcpText).forEach((s) => {
      if (s?.name) current.add(s.name);
    });
  } catch {
    current = new Set();
  }
  const assigned = new Set(state.mcpCatalog?.assignments?.[draft.id] || []);
  const chips = servers
    .map((s) => {
      const on = current.has(s.id);
      const def = assigned.has(s.id);
      const cls = ["mcp-chip", on ? "on" : "", def ? "default" : "", s.optional ? "optional" : ""]
        .filter(Boolean)
        .join(" ");
      const title = [s.vendor, s.auth, s.notes].filter(Boolean).join(" — ");
      return `<button type="button" class="${cls}" data-mcp-chip="${escapeAttr(s.id)}" title="${escapeAttr(title)}">${on ? "✓" : "+"} ${escapeHtml(s.id)}</button>`;
    })
    .join("");
  return `<label class="field">Catalog</label>
    <div class="mcp-chips">${chips}</div>
    <div class="row-actions" style="margin:8px 0 4px">
      <button type="button" class="secondary" id="pe-mcp-apply">Apply catalog defaults</button>
    </div>
    <p class="preview">Highlighted chips are this profile’s payer defaults. Click to add/remove in the JSON. Apply catalog defaults POSTs the merge (existing same-name rows stay) then reloads; new profiles fill JSON until you save. HTTP rows Sign in after save.</p>`;
}

async function applyCatalogToProfile(id, draftOverride) {
  if (!id) return;
  try {
    const r = await api(`/profiles/${encodeURIComponent(id)}/mcp/apply-catalog`, {
      method: "POST",
      body: "{}",
    });
    banner("Catalog defaults merged — Sign in HTTP rows");
    await refresh();
    if (state.profileEditor?.id === id || draftOverride) {
      const src = (state.adminProfiles || []).find((p) => p.id === id);
      const draft = draftOverride
        ? { ...draftOverride, mcpText: mcpToText(r.mcpServers || src?.mcpServers) }
        : undefined;
      openProfileEditor(id, draft);
    } else {
      renderProfiles();
    }
  } catch (e) {
    banner(e.message, true);
  }
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
    const [sessions, projects, profiles, catalog] = await Promise.all([
      api("/sessions"),
      api("/projects").catch(() => ({ projects: [] })),
      // Ask for admin payload; server ignores it for non-loopback callers.
      api("/profiles?admin=1").catch(() => ({ profiles: [], admin: false })),
      api("/mcp/catalog").catch(() => null),
    ]);
    state.sessions = sessions.sessions || [];
    state.archived = sessions.archivedSessions || [];
    state.disk = sessions.diskSessions || [];
    state.claude = sessions.claudeSessions || [];
    state.projects = projects.projects || [];
    state.profiles = profiles.profiles || [];
    state.admin = profiles.admin === true;
    state.adminProfiles = profiles.adminProfiles || [];
    if (catalog?.servers) state.mcpCatalog = catalog;
    if (!state.profileId && state.profiles[0]) state.profileId = state.profiles[0].id;
    setConn(true);
    // WS / ↻ used to call renderList() whenever no session detail was open,
    // which yanked Profiles (and the editor) back to the session list.
    if (state.tab === "profiles") {
      if (!state.profileEditor) renderProfiles();
      return;
    }
    if (state.tab === "settings" || state.tab === "compose") return;
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

async function connectWs() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* */
    }
  }
  if (!state.token) return;
  try {
    // RFC-029: never put the host token in the WebSocket URL — trade it for
    // a single-use ticket first.
    const { ticket } = await api("/ws/ticket", { method: "POST" });
    const u = new URL(state.baseURL);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws";
    u.search = `ticket=${encodeURIComponent(ticket)}`;
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

/** Diff or command the approval will run (RFC-033). */
function approvalPreviewHtml(p) {
  if (!p) return "";
  const lines =
    p.type === "command"
      ? String(p.command || "").split("\n").map((l, i) => `<div>${i === 0 ? "$ " : "  "}${escapeHtml(l)}</div>`)
      : [
          ...(p.oldText ? String(p.oldText).split("\n").map((l) => `<div class="del">- ${escapeHtml(l)}</div>`) : []),
          ...(p.newText ? String(p.newText).split("\n").map((l) => `<div class="add">+ ${escapeHtml(l)}</div>`) : []),
        ];
  return `<div class="approval-preview">
    ${p.path ? `<div class="meta" title="${escapeHtml(p.path)}">${escapeHtml(String(p.path).split("/").pop())}</div>` : ""}
    <pre>${lines.join("")}</pre>
    ${p.truncated ? `<div class="meta">Preview truncated.</div>` : ""}
  </div>`;
}

/** Project name when the host knows it (RFC-032 infers it from the folder); else the folder. */
function projectLabel(s) {
  const p = s.projectId && state.projects.find((x) => x.id === s.projectId);
  return p ? p.name : shortPath(s.cwd);
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

  const start = () => {
    if (!state.token) {
      renderSettings();
    } else {
      connectWs();
      refresh().then(() => renderList());
    }
  };

  if (state.token) {
    start();
    return;
  }
  // Same-origin /app/ (tray "Open web UI") — /connect.json already
  // exposes the token on this host, same as /setup.
  fetch("/connect.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => {
      if (c?.hostToken) {
        state.token = c.hostToken;
        localStorage.setItem(STORAGE_TOKEN, state.token);
        state.baseURL = window.location.origin;
        localStorage.setItem(STORAGE_URL, state.baseURL);
      }
    })
    .catch(() => {})
    .finally(start);
}

boot();
