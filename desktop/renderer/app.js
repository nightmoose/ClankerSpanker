"use strict";

const RECENT_LIMIT = 5;
const AUTH_MARKERS = [
  "please run /login",
  "not logged in",
  "failed to authenticate",
  "run grok login",
  "oauth token missing",
  "oauth token revoked",
  "oauth token expired",
  "login required",
];

const state = {
  nav: "sessions",
  filter: "recent",
  search: "",
  searchDebounce: null,
  hostSearchHits: null,
  searchingHost: false,
  sessions: [],
  archived: [],
  disk: [],
  claude: [],
  agy: [],
  projects: [],
  profiles: [],
  profileId: null,
  enabledProfileIds: [],
  detail: null,
  selectedId: null,
  tab: "transcript",
  chatOnly: false,
  sessionFiles: [],
  sessionFilesFor: null,
  diff: null,
  diffLoading: false,
  approvalDraftComment: "",
  followupDraft: "",
  pendingImages: [],
  composeDraft: {
    title: "",
    prompt: "",
    projectId: "",
    cwd: "",
    planMode: true,
    worktree: true,
    subagents: true,
    images: [],
    extraDirs: [],
  },
  wsStatus: "offline",
  hostStatus: null,
  desktopConfig: null,
  hostConfig: null,
  hostConfigPath: "",
  refreshTimer: null,
  usageTimer: null,
  lastSeqBySession: {},
  streamingText: "",
  streamingTimer: null,
  showViewer: false,
  viewerPath: "",
  tasks: [],
  tasksShowDone: false,
  tasksSearch: "",
  projectSearch: "",
  // Bots (hunter)
  bots: [],
  botsLoading: false,
  selectedBotId: null,
  botOutbox: {},
  botDraftJob: {},
  botRunNote: {},
  newBotOpen: false,
  newBotDraft: { name: "", job: "", profileId: "", projectId: "", interval: "6h", enabled: false },
  newBotSaving: false,
  loginAckedFor: "",
  noteDraft: "",
  taskDraft: "",
  // Profiles manager (loopback-only). Populated by Api.profiles({ admin }).
  adminProfiles: [],
  admin: false,
  profileEditor: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

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
function shortPath(p) {
  if (!p) return "";
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/") || p;
}

function projectPrimaryPath(p) {
  if (!p) return "";
  if (Array.isArray(p.paths) && p.paths[0]) return p.paths[0];
  return p.path || "";
}
function isGrokBackend(b) {
  return !b || b === "grok";
}
function showsAllProfiles() {
  const ids = (state.profiles || []).map((p) => p.id);
  if (!ids.length) return true;
  const enabled = state.enabledProfileIds || [];
  if (!enabled.length) return true;
  return ids.every((id) => enabled.includes(id));
}
function usagePeak(u) {
  if (!u) return null;
  const vals = [u.fiveHourPercent, u.sevenDayPercent, u.sevenDayOpusPercent].filter(
    (n) => typeof n === "number",
  );
  return vals.length ? Math.max(...vals) : null;
}
function usageSubtitle(u) {
  if (!u) return null;
  const peak = usagePeak(u);
  if (peak != null) return `${Math.round(peak)}%`;
  if (u.label) return u.label;
  if (u.status === "limited") return "100%";
  if (u.status === "unknown") return "?";
  if (u.status === "error") return "…";
  if (u.canWork === false) return "!";
  return null;
}
function usageTraffic(u) {
  const peak = usagePeak(u);
  if (peak == null) {
    if (u?.status === "limited") return "err";
    if (u?.status === "error") return "warn";
    return "";
  }
  if (peak >= 95) return "err";
  if (peak >= 75) return "warn";
  return "ok";
}
function resolveFsPath(p, cwd) {
  if (!p) return "";
  if (p.startsWith("/") || p.startsWith("~")) return p;
  if (cwd) return String(cwd).replace(/\/$/, "") + "/" + String(p).replace(/^\.\//, "");
  return p;
}
function projectNameFor(session) {
  if (!session?.projectId) return "";
  const p = (state.projects || []).find((x) => x.id === session.projectId);
  return p?.name || "";
}
function needsReLogin(detail) {
  if (!detail) return false;
  if (state.loginAckedFor === `${detail.id}:${detail.updatedAt || ""}`) return false;
  const lastNonUser = [...(detail.transcript || [])].reverse().find((e) => e.role !== "user");
  const blob = [detail.error, lastNonUser?.text].filter(Boolean).join("\n").toLowerCase();
  if (
    blob.includes("oauth-protected-resource") ||
    blob.includes("resource_metadata") ||
    blob.includes("mcp connector needs sign in")
  ) {
    return false;
  }
  return AUTH_MARKERS.some((m) => blob.includes(m));
}

function statusClass(s) {
  return `status ${String(s || "").replace(/[^a-z_]/g, "")}`;
}

function banner(msg, isError = false) {
  const el = $("#banner");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(banner._t);
  banner._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ——— Connection bootstrap ———

async function syncConnection() {
  const conn = await window.clanker.getConnection();
  Api.setConnection(conn);
  state.desktopConfig = await window.clanker.getDesktopConfig();
  return conn;
}

async function refreshHostStatus() {
  try {
    state.hostStatus = await window.clanker.hostStatus();
    renderHostMini();
    if (state.nav === "host") renderHost();
  } catch (e) {
    console.warn(e);
  }
}

function renderHostMini() {
  const el = $("#host-mini");
  const hs = state.hostStatus;
  if (!hs) {
    el.textContent = "Host …";
    return;
  }
  const live = hs.probe?.ok;
  const proc = hs.running ? `pid ${hs.pid}` : "stopped";
  el.innerHTML = `${escapeHtml(hs.mode)} · ${live ? "API up" : "API down"} · ${escapeHtml(proc)}`;
  const canStart = hs.mode === "managed" && !hs.startedByUs && !live;
  $("#btn-host-start").disabled = !canStart;
  $("#btn-host-stop").disabled = !(hs.running && hs.startedByUs);
}

function renderActiveHostChip() {
  const el = $("#active-host-chip");
  if (!el) return;
  const d = state.desktopConfig;
  const hosts = Array.isArray(d?.hosts) ? d.hosts : [];
  const active = hosts.find((h) => h.id === d?.activeHostId) || hosts[0];
  if (!active || hosts.length <= 1) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `<span class="dot"></span>${escapeHtml(active.name || active.hostURL || "host")}
    <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3 L5 7 L8 3" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  el.onclick = () => showHostPicker();
}

function showHostPicker() {
  const d = state.desktopConfig;
  const hosts = Array.isArray(d?.hosts) ? d.hosts : [];
  const active = d?.activeHostId;
  const menu = document.createElement("div");
  menu.className = "menu-pop";
  menu.innerHTML = hosts
    .map(
      (h) => `<button type="button" class="menu-item ${h.id === active ? "active" : ""}" data-h="${escapeAttr(h.id)}">
      <span class="menu-name">${escapeHtml(h.name || "host")}</span>
      <span class="menu-sub">${escapeHtml(h.hostURL)}</span>
    </button>`,
    )
    .join("") + `<div class="menu-sep"></div>
    <button type="button" class="menu-item" data-manage="1">Manage hosts…</button>`;
  document.body.appendChild(menu);
  const chip = $("#active-host-chip");
  const rect = chip.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onEsc, true);
  };
  const onDoc = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onEsc = (e) => {
    if (e.key === "Escape") close();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onEsc, true);
  }, 0);

  menu.querySelectorAll("[data-h]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      close();
      const id = btn.getAttribute("data-h");
      await switchHost(id);
    });
  });
  menu.querySelector("[data-manage]")?.addEventListener("click", () => {
    close();
    setNav("settings");
  });
}

async function switchHost(id) {
  await window.clanker.setActiveHost(id);
  await syncConnection();
  await refreshHostStatus();
  state.detail = null;
  state.selectedId = null;
  state.lastSeqBySession = {};
  renderActiveHostChip();
  renderSessionList();
  renderDetail();
  await refreshSessions();
  banner("Switched host");
}

function setWsPill(status) {
  const wasOffline = state.wsStatus !== "live";
  state.wsStatus = status;
  const el = $("#ws-pill");
  el.textContent = status === "live" ? "live" : status === "connecting" ? "…" : "offline";
  el.classList.toggle("ok", status === "live");
  el.classList.toggle("warn", status === "connecting");
  el.classList.toggle("muted", status === "offline");
  if (status === "live" && wasOffline && state.selectedId) {
    catchUpEvents(state.selectedId);
  }
}

// ——— Navigation ———

function setNav(nav) {
  state.nav = nav;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.nav === nav));

  const titles = {
    sessions: "Sessions",
    projects: "Projects",
    tasks: "Tasks",
    bots: "Bots",
    terminal: "Terminal",
    compose: "Compose",
    grok: "Grok disk",
    claude: "Claude disk",
    agy: "Gemini disk",
    profiles: "Profiles",
    host: "Host",
    settings: "Desktop",
  };
  $("#view-title").textContent = titles[nav] || nav;
  $("#toolbar").classList.toggle(
    "hidden",
    nav === "host" || nav === "settings" || nav === "profiles",
  );
  $(".toolbar-right").classList.toggle("hidden", nav !== "sessions");
  $("#profile-bar").classList.toggle("hidden", nav !== "sessions" && nav !== "compose");
  $("#session-count")?.classList.toggle("hidden", nav !== "sessions");
  const viewerBtn = $("#btn-viewer");
  if (viewerBtn) {
    viewerBtn.classList.toggle("hidden", nav !== "sessions");
    viewerBtn.classList.toggle("active-tool", state.showViewer);
  }

  $("#view-sessions").classList.toggle("active", nav === "sessions");
  $("#view-sessions").classList.toggle("hidden", nav !== "sessions");
  $("#view-projects")?.classList.toggle("hidden", nav !== "projects");
  $("#view-tasks")?.classList.toggle("hidden", nav !== "tasks");
  $("#view-bots")?.classList.toggle("hidden", nav !== "bots");
  $("#view-terminal")?.classList.toggle("hidden", nav !== "terminal");
  $("#view-compose").classList.toggle("hidden", nav !== "compose");
  $("#view-disk").classList.toggle("hidden", nav !== "grok" && nav !== "claude" && nav !== "agy");
  $("#view-host").classList.toggle("hidden", nav !== "host");
  $("#view-profiles")?.classList.toggle("hidden", nav !== "profiles");
  $("#view-settings").classList.toggle("hidden", nav !== "settings");

  syncViewerPane();

  if (nav === "sessions") {
    renderSessionList();
    if (state.detail) renderDetail();
  } else if (nav === "projects") renderProjects();
  else if (nav === "tasks") renderTasks();
  else if (nav === "bots") renderBots();
  else if (nav === "terminal") renderTerminal();
  else if (nav === "compose") renderCompose();
  else if (nav === "grok" || nav === "claude" || nav === "agy") renderDisk(nav);
  else if (nav === "profiles") renderProfilesAdmin();
  else if (nav === "host") renderHost();
  else if (nav === "settings") renderDesktopSettings();
}

// ——— Profiles ———

function renderProfiles() {
  const bar = $("#profile-bar");
  if (!bar) return;
  if (!state.profiles.length) {
    bar.innerHTML = "";
    return;
  }
  const radio = state.nav === "compose";
  const allOn = showsAllProfiles();
  bar.innerHTML = state.profiles
    .map((p) => {
      const selected = radio
        ? p.id === state.profileId
        : allOn || (state.enabledProfileIds || []).includes(p.id);
      const sub = usageSubtitle(p.usage);
      const traffic = usageTraffic(p.usage);
      return `<button type="button" class="profile-chip ${selected ? "active" : ""}" data-profile="${escapeAttr(p.id)}" style="--chip:${escapeAttr(p.color || "#73b8ff")}">
        <span class="dot" style="background:${escapeAttr(p.color || "#73b8ff")}"></span>
        <span class="chip-col">
          <span class="chip-name">${escapeHtml(p.name)}</span>
          <span class="chip-usage ${traffic}">${escapeHtml(sub || "Usage")}</span>
        </span>
        ${traffic && sub ? `<span class="traffic ${traffic}"></span>` : ""}
      </button>`;
    })
    .join("");
  bar.querySelectorAll("[data-profile]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-profile");
      if (radio) {
        state.profileId = id;
      } else {
        let enabled = [...(state.enabledProfileIds || [])];
        const ids = state.profiles.map((p) => p.id);
        if (!enabled.length || showsAllProfiles()) {
          enabled = ids.filter((x) => x !== id);
        } else if (enabled.includes(id)) {
          enabled = enabled.filter((x) => x !== id);
        } else {
          enabled.push(id);
        }
        state.enabledProfileIds = enabled;
        if (enabled.includes(id) || !enabled.length) state.profileId = id;
      }
      renderProfiles();
      if (state.nav === "sessions") renderSessionList();
      if (state.nav === "compose") renderCompose();
    });
  });
  updateSessionCount();
}

// ——— Sessions (command center) ———

function sessionPoolForFilter() {
  if (state.filter === "archived") return state.archived;
  const rows = [...(state.sessions || [])].sort((a, b) =>
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
  );
  if (state.filter === "recent") return rows.slice(0, RECENT_LIMIT);
  return rows;
}

function matchesProfileFilter(s) {
  if (showsAllProfiles()) return true;
  const enabled = state.enabledProfileIds || [];
  if (!enabled.length) return true;
  if (s.profileId) return enabled.includes(s.profileId);
  const backends = new Set(
    state.profiles.filter((p) => enabled.includes(p.id)).map((p) => p.backend || "grok"),
  );
  return backends.has(s.backend || "grok");
}

function localHaystack(s) {
  return [
    s.title,
    s.prompt,
    s.cwd,
    s.transcriptPreview,
    s.profileName,
    s.profileId,
    s.model,
    s.error,
    s.status,
    s.backend,
    s.projectId,
    projectNameFor(s),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function mergeSearchHits() {
  const q = state.search.trim();
  if (!q) return null;
  const byId = {};
  for (const s of [...(state.sessions || []), ...(state.archived || [])]) {
    if (localHaystack(s).includes(q.toLowerCase())) byId[s.id] = s;
  }
  for (const s of state.hostSearchHits || []) byId[s.id] = s;
  return Object.values(byId).sort((a, b) =>
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
  );
}

function filteredSessions() {
  const q = state.search.trim();
  let rows = q ? mergeSearchHits() || [] : sessionPoolForFilter();
  rows = rows.filter(matchesProfileFilter);
  return rows;
}

function updateSessionCount() {
  const el = $("#session-count");
  if (!el) return;
  if (state.nav !== "sessions") {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const shown = filteredSessions().length;
  const pool = state.filter === "archived" ? state.archived.length : state.sessions.length;
  el.textContent = showsAllProfiles() || state.filter === "archived" ? String(shown) : `${shown}/${pool}`;
  el.title = state.search.trim()
    ? `${shown} match(es) (titles + message content)`
    : showsAllProfiles()
      ? `${shown} sessions`
      : `${shown} for selected profiles · ${pool} total on host`;
}

function renderSessionList() {
  const root = $("#session-list");
  const rows = filteredSessions();
  const searchVal = escapeAttr(state.search || "");
  const noToken = !Api.getConnection().token;

  const chrome = `
    <div class="list-chrome">
      <div class="filter-seg" role="tablist">
        <button type="button" data-filter="recent" class="${state.filter === "recent" ? "active" : ""}">Recent</button>
        <button type="button" data-filter="active" class="${state.filter === "active" ? "active" : ""}">Active</button>
        <button type="button" data-filter="archived" class="${state.filter === "archived" ? "active" : ""}">Archived</button>
      </div>
      <input id="session-search" class="search-input" placeholder="Search titles, paths &amp; message content" value="${searchVal}" />
    </div>`;

  let body;
  if (noToken) {
    body = `<div class="list-empty">No host token yet.<br/>Open <strong>Host</strong> and start the gateway.</div>`;
  } else if (!rows.length) {
    const noun = state.filter === "archived" ? "archived" : state.filter === "active" ? "active" : "";
    const suffix = state.search ? " matching your search" : "";
    body = `<div class="list-empty">No ${noun ? noun + " " : ""}sessions${suffix}.<br/>Use <strong>Compose</strong> to dispatch a task.</div>`;
  } else {
    body = rows
      .map((s) => {
        const selected = s.id === state.selectedId ? "selected" : "";
        const attention =
          s.status === "awaiting_approval" || s.status === "awaiting_question" ? "⚠ " : "";
        return `
        <button type="button" class="session-card ${selected}" data-open="${escapeAttr(s.id)}" style="${s.profileColor ? `--stripe:${escapeAttr(s.profileColor)}` : ""}">
          <h3>${attention}${escapeHtml(s.title || "Session")}</h3>
          <div class="meta">
            <span class="${statusClass(s.status)}">${escapeHtml(s.status)}</span>
            <span>${escapeHtml(s.profileName || s.backend || "")}</span>
            ${projectNameFor(s) ? `<span>${escapeHtml(projectNameFor(s))}</span>` : ""}
            <span>${escapeHtml(shortPath(s.cwd))}</span>
            ${s.isLive ? "<span>live</span>" : ""}
          </div>
          <div class="preview">${escapeHtml(s.transcriptPreview || s.prompt || "")}</div>
        </button>`;
      })
      .join("");
  }

  root.innerHTML = chrome + `<div class="list-scroll">${body}</div>`;

  root.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filter = btn.getAttribute("data-filter");
      renderSessionList();
    });
  });
  root.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => openSession(el.getAttribute("data-open")));
  });
  const searchEl = $("#session-search");
  if (searchEl) {
    searchEl.addEventListener("input", (e) => {
      clearTimeout(state.searchDebounce);
      state.searchDebounce = setTimeout(() => {
        state.search = e.target.value;
        scheduleHostSearch(state.search);
        renderSessionList();
      }, 250);
    });
  }
  updateSessionCount();
}

function scheduleHostSearch(query) {
  const q = String(query || "").trim();
  if (!q) {
    state.hostSearchHits = null;
    state.searchingHost = false;
    return;
  }
  state.searchingHost = true;
  if (!state._searchGen) state._searchGen = 0;
  const token = ++state._searchGen;
  Api.sessions(q)
    .then((res) => {
      if (token !== state._searchGen) return;
      const hits = [...(res.sessions || []), ...(res.archivedSessions || [])];
      state.hostSearchHits = hits;
      state.searchingHost = false;
      if (state.nav === "sessions") renderSessionList();
    })
    .catch(() => {
      if (token !== state._searchGen) return;
      state.searchingHost = false;
    });
}

async function openSession(id, messageId) {
  const isNew = state.selectedId !== id;
  state.selectedId = id;
  if (isNew) {
    state.tab = "transcript";
    state.diff = null;
    state.approvalDraftComment = "";
    state.streamingText = "";
    state.pendingImages = [];
    state.noteDraft = "";
    state.taskDraft = "";
    state.sessionFiles = [];
    state.sessionFilesFor = null;
  }
  if (messageId) {
    state.tab = "transcript";
    state.pendingJumpMessageId = messageId;
  }
  try {
    state.detail = await Api.session(id);
    trackHighestSeq(state.detail);
    renderSessionList();
    renderDetail();
    $("#view-sessions").classList.add("detail-open");
    jumpToPendingMessage();
  } catch (e) {
    banner(e.message, true);
  }
}

function jumpToPendingMessage(attempt) {
  const id = state.pendingJumpMessageId;
  if (!id) return;
  const n = attempt || 0;
  const el = document.getElementById(`msg-${id}`);
  if (el) {
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash-msg");
    state.pendingJumpMessageId = null;
    return;
  }
  if (n < 12) setTimeout(() => jumpToPendingMessage(n + 1), 80);
}

// ——— Detail (transcript + tabs) ———

function renderDetail() {
  const root = $("#session-detail");
  const d = state.detail;
  if (!d) {
    root.className = "panel detail-panel empty-detail";
    root.innerHTML = `<p class="muted-center">Select a session</p>`;
    return;
  }
  root.className = "panel detail-panel";

  // Preserve typed followup text + focus/selection across re-renders.
  // WS events trigger renderDetail() frequently — without this, any keystroke
  // between events is wiped when innerHTML is reassigned below.
  const followupEl = document.getElementById("followup-input");
  if (followupEl) state.followupDraft = followupEl.value;
  const activeEl = document.activeElement;
  const focusedId = activeEl && activeEl.id ? activeEl.id : null;
  const focusedSelStart = activeEl && typeof activeEl.selectionStart === "number" ? activeEl.selectionStart : null;
  const focusedSelEnd = activeEl && typeof activeEl.selectionEnd === "number" ? activeEl.selectionEnd : null;

  const pendingA = d.pendingApproval;
  const pendingQ = d.pendingQuestion;
  const running = ["running", "queued"].includes(d.status);
  const hasPlan = Array.isArray(d.plan) && d.plan.length > 0;
  const hasNotes = (d.notes || []).length > 0 || (d.tasks || []).length > 0;

  root.innerHTML = `
    <div class="detail-head">
      <div class="detail-head-main">
        <button type="button" class="ghost" id="btn-back-list" style="display:none;margin-bottom:8px">← Back</button>
        <h3>${escapeHtml(d.title)}</h3>
        <div class="meta">
          <span class="${statusClass(d.status)}">${escapeHtml(d.status)}</span>
          <span>${escapeHtml(d.model || "")}</span>
          <span title="${escapeAttr(d.cwd)}">${escapeHtml(shortPath(d.cwd))}</span>
          <span>${escapeHtml(d.profileName || d.backend || "")}</span>
          ${d.usage?.totalTokens ? `<span>${escapeHtml(String(d.usage.totalTokens))} tok</span>` : ""}
        </div>
        ${d.error ? `<p class="preview" style="color:var(--danger)">${escapeHtml(d.error)}</p>` : ""}
      </div>
      <div class="row-actions">
        <button type="button" class="secondary" id="btn-session-menu">⋯</button>
      </div>
    </div>
    ${needsReLogin(d) ? `<div class="login-banner" id="login-banner">
      <span>This profile needs to sign in again. Login opens a browser on the <strong>host</strong> machine.</span>
      <button type="button" class="primary" id="btn-relogin">Sign in on host</button>
    </div>` : ""}

    <div class="detail-tabs" role="tablist">
      <button type="button" data-tab="transcript" class="${state.tab === "transcript" ? "active" : ""}">Transcript</button>
      ${state.tab === "transcript" ? `<label class="check chat-only-toggle"><input type="checkbox" id="chat-only" ${state.chatOnly ? "checked" : ""}/> Chat only</label>` : ""}
      <button type="button" data-tab="tools" class="${state.tab === "tools" ? "active" : ""}">Tools <span class="tab-count">${(d.toolCalls || []).length}</span></button>
      <button type="button" data-tab="plan" class="${state.tab === "plan" ? "active" : ""}" ${hasPlan ? "" : ""}>Plan${hasPlan ? ` <span class="tab-count">${d.plan.length}</span>` : ""}</button>
      <button type="button" data-tab="diff" class="${state.tab === "diff" ? "active" : ""}">Diff</button>
      <button type="button" data-tab="notes" class="${state.tab === "notes" ? "active" : ""}">Notes${hasNotes ? ` <span class="tab-count">${(d.notes || []).length + (d.tasks || []).length}</span>` : ""}</button>
    </div>

    <div class="tab-body" id="tab-body"></div>

    ${
      pendingA
        ? renderApprovalBar(pendingA)
        : ""
    }
    ${
      pendingQ
        ? renderQuestionBar(pendingQ)
        : ""
    }
    ${
      !pendingA && !pendingQ && d.status !== "cancelled" && d.status !== "failed"
        ? `<div class="followup-wrap">
            ${state.pendingImages.length ? `<div class="img-row">${state.pendingImages.map((im, i) =>
              `<span class="img-thumb"><img src="data:${escapeAttr(im.mimeType)};base64,${escapeAttr(im.data)}" alt=""/><button type="button" class="img-x" data-rm-img="${i}">×</button></span>`
            ).join("")}</div>` : ""}
            <div class="followup">
              <button type="button" class="ghost" id="btn-attach-img" title="Attach images">🖼</button>
              <input id="followup-input" placeholder="Message agent… (Enter to send)" value="${escapeAttr(state.followupDraft || "")}" />
              <button type="button" class="primary" id="btn-send">Send</button>
            </div>
          </div>`
        : ""
    }
  `;

  renderTabBody(d, running);

  const back = $("#btn-back-list");
  if (back) {
    if (window.matchMedia("(max-width: 1000px)").matches) back.style.display = "inline-block";
    back.addEventListener("click", () => {
      state.detail = null;
      state.selectedId = null;
      $("#view-sessions").classList.remove("detail-open");
      renderDetail();
      renderSessionList();
    });
  }

  root.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.tab = btn.getAttribute("data-tab");
      renderDetail();
      if (state.tab === "diff" && !state.diff && !state.diffLoading) loadDiff();
    });
  });
  $("#chat-only")?.addEventListener("change", (e) => {
    state.chatOnly = Boolean(e.target.checked);
    renderTabBody(d, running);
    wireTranscriptCapture(d);
    wireOpenPaths(d);
  });

  wireSessionMenu(d);
  $("#btn-relogin")?.addEventListener("click", () => startProfileLogin(d));

  wireApprovalControls(d, pendingA);
  wireQuestionControls(d, pendingQ);

  const send = async () => {
    const input = $("#followup-input");
    const text = input?.value?.trim() || "";
    if (!text && !state.pendingImages.length) return;
    try {
      const body = { prompt: text };
      if (state.pendingImages.length) {
        body.images = state.pendingImages.map((im) => ({
          mimeType: im.mimeType,
          data: im.data,
          name: im.name,
        }));
      }
      state.detail = await Api.prompt(d.id, body);
      trackHighestSeq(state.detail);
      state.followupDraft = "";
      state.pendingImages = [];
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  };
  $("#btn-attach-img")?.addEventListener("click", async () => {
    const files = await window.clanker.pickFiles({ images: true });
    if (!files?.length) return;
    state.pendingImages = [...state.pendingImages, ...files];
    renderDetail();
  });
  root.querySelectorAll("[data-rm-img]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-rm-img"));
      state.pendingImages.splice(i, 1);
      renderDetail();
    });
  });
  $("#btn-send")?.addEventListener("click", send);
  $("#followup-input")?.addEventListener("input", (e) => {
    state.followupDraft = e.target.value;
  });
  $("#followup-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Restore focus + caret so re-renders don't interrupt typing.
  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el) {
      try {
        el.focus({ preventScroll: true });
        if (focusedSelStart !== null && typeof el.setSelectionRange === "function") {
          el.setSelectionRange(focusedSelStart, focusedSelEnd ?? focusedSelStart);
        }
      } catch {
        /* focus may fail if element type doesn't support it — safe to ignore */
      }
    }
  }

  scrollTranscriptToEnd();
  wireTranscriptCapture(d);
  wireOpenPaths(d);
}

function renderTabBody(d, running) {
  const el = $("#tab-body");
  if (!el) return;
  if (state.tab === "transcript") {
    el.innerHTML = renderTranscriptItems(d, running);
    scrollTranscriptToEnd();
    return;
  }
  if (state.tab === "tools") {
    el.innerHTML = renderToolsTab(d);
    return;
  }
  if (state.tab === "plan") {
    el.innerHTML = renderPlanTab(d);
    return;
  }
  if (state.tab === "diff") {
    el.innerHTML = renderDiffTab(d);
    return;
  }
  if (state.tab === "notes") {
    el.innerHTML = renderNotesTab(d);
    wireNotesTab(d);
    if (state.sessionFilesFor !== d.id) {
      Api.sessionFiles(d.id)
        .then((res) => {
          state.sessionFiles = res.files || [];
          state.sessionFilesFor = d.id;
          if (state.tab === "notes" && state.detail?.id === d.id) {
            el.innerHTML = renderNotesTab(d);
            wireNotesTab(d);
          }
        })
        .catch(() => undefined);
    }
    return;
  }
}

function scrollTranscriptToEnd() {
  const scroll = document.getElementById("transcript");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

// Merge transcript + tool calls sorted by timestamp so the reader sees
// what the agent is actually doing between assistant turns instead of a blank gap.
function mergedItems(d) {
  const entries = (d.transcript || [])
    .filter((e) => !state.chatOnly || e.role === "user" || e.role === "assistant")
    .map((e) => ({ kind: "entry", at: e.at, data: e }));
  const tools = state.chatOnly
    ? []
    : (d.toolCalls || []).map((t) => ({ kind: "tool", at: t.updatedAt, data: t }));
  return [...entries, ...tools].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function renderTranscriptItems(d, running) {
  const items = mergedItems(d);
  if (!items.length && !state.streamingText && !running) {
    return `<div class="transcript" id="transcript"><div class="list-empty">No transcript yet.</div></div>`;
  }
  const rendered = items
    .map((it) => (it.kind === "entry" ? renderBubble(it.data, false) : renderToolRow(it.data)))
    .join("");
  const stream = state.streamingText
    ? renderBubble({ id: "streaming", role: "assistant", text: state.streamingText, at: "" }, true)
    : running
      ? `<div class="tool-row still-working"><span class="spinner"></span>Still working…</div>`
      : "";
  return `<div class="transcript" id="transcript">${rendered}${stream}</div>`;
}

function renderBubble(entry, isStreaming) {
  const roleLabel =
    entry.role === "user"
      ? "You"
      : entry.role === "thought"
        ? "Thinking"
        : entry.role === "system"
          ? "System"
          : "Agent";
  const cls =
    entry.role === "user"
      ? "bubble user"
      : entry.role === "thought"
        ? "bubble thought"
        : entry.role === "system"
          ? "bubble system"
          : "bubble";
  const mid = entry.id ? ` id="msg-${escapeAttr(entry.id)}"` : "";
  return `<div class="${cls}${isStreaming ? " streaming" : ""}"${mid} data-msg="${escapeAttr(entry.id || "")}">
    <div class="role">${escapeHtml(roleLabel)}</div>
    <div class="text">${escapeHtml(entry.text || "")}</div>
  </div>`;
}

function toolIconSvg(kind, title) {
  const t = (title || "").toLowerCase();
  const k = (kind || "").toLowerCase();
  const map = {
    read: "M4 3h9l3 3v11H4z M13 3v3h3",
    write: "M4 3h12v14H4z M7 7h6 M7 10h6 M7 13h4",
    edit: "M3 14 L11 6 L14 9 L6 17 L3 17z",
    execute: "M4 4h12v12H4z M7 8l3 2-3 2z",
    bash: "M4 4h12v12H4z M7 8l3 2-3 2z",
    search: "M9 3a6 6 0 1 1-4.24 10.24L2 16 M13.5 13.5 17 17",
    grep: "M9 3a6 6 0 1 1-4.24 10.24L2 16 M13.5 13.5 17 17",
    todo: "M4 6h12 M4 10h12 M4 14h8",
    plan: "M4 4h12v12H4z M7 7h6 M7 10h6 M7 13h4",
    fetch: "M10 3a7 7 0 1 0 0 14a7 7 0 0 0 0-14 M3 10h14 M10 3c3 3 3 11 0 14 M10 3c-3 3-3 11 0 14",
  };
  const key =
    t.includes("read") ? "read" :
    t.includes("write") ? "write" :
    t.includes("edit") ? "edit" :
    t.includes("bash") || t.includes("run") ? "bash" :
    t.includes("grep") || t.includes("search") ? "search" :
    t.includes("todo") ? "todo" :
    t.includes("fetch") || t.includes("web") ? "fetch" :
    k === "edit" ? "edit" :
    k === "execute" ? "execute" :
    k === "search" ? "search" :
    k === "read" ? "read" :
    "plan";
  return `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${map[key]}"/></svg>`;
}

function renderToolRow(t) {
  const status = String(t.status || "").toLowerCase();
  const statusCls =
    status === "completed"
      ? "ok"
      : status === "failed" || status === "error"
        ? "err"
        : status === "pending" || status === "running" || status === "in_progress"
          ? "warn"
          : "";
  const statusLabel =
    status === "completed" ? "done" :
    status === "pending" || status === "running" || status === "in_progress" ? "…" :
    status === "failed" || status === "error" ? "failed" :
    status;
  const path = t.locations && t.locations[0] ? t.locations[0].path : "";
  return `<div class="tool-row ${statusCls}">
    <span class="tool-ico">${toolIconSvg(t.kind, t.title)}</span>
    <span class="tool-title">${escapeHtml(t.title || t.kind || "tool")}</span>
    ${path ? `<button type="button" class="tool-path" data-open-path="${escapeAttr(path)}">${escapeHtml(path)}</button>` : ""}
    <span class="tool-status ${statusCls}">${escapeHtml(statusLabel)}</span>
  </div>`;
}

function renderToolsTab(d) {
  const tools = [...(d.toolCalls || [])].sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
  if (!tools.length) return `<div class="list-empty">No tool calls yet.</div>`;
  return `<div class="tool-list">${tools.map(renderToolRow).join("")}</div>`;
}

function renderPlanTab(d) {
  const plan = d.plan || [];
  if (!plan.length) return `<div class="list-empty">No plan yet.</div>`;
  return `<ol class="plan-list">${plan
    .map(
      (p) => `<li class="plan-item ${escapeAttr(String(p.status || "").toLowerCase())}">
        <span class="plan-status">${escapeHtml(p.status || "pending")}</span>
        <span class="plan-text">${escapeHtml(p.content || "")}</span>
      </li>`,
    )
    .join("")}</ol>`;
}

function renderDiffTab(d) {
  if (state.diffLoading) return `<div class="list-empty">Loading diff…</div>`;
  const diff = state.diff;
  if (!diff) {
    return `<div class="list-empty">No diff loaded. <button type="button" class="ghost" id="btn-load-diff">Load diff</button></div>`;
  }
  const files = Array.isArray(diff.files) ? diff.files : [];
  if (!files.length && !diff.raw) return `<div class="list-empty">No changes.</div>`;
  const hasFiles = files.length > 0;
  const body = hasFiles
    ? files
        .map(
          (f) => `<details class="diff-file" open>
      <summary><button type="button" class="ghost" data-open-path="${escapeAttr(f.path || "")}">${escapeHtml(f.path || "file")}</button> <span class="diff-stat">${f.additions ?? "?"}+/${f.deletions ?? "?"}−</span></summary>
      <pre class="diff-body">${escapeHtml(f.patch || f.raw || "")}</pre>
    </details>`,
        )
        .join("")
    : `<pre class="diff-body">${escapeHtml(diff.raw || "")}</pre>`;
  return `<div class="diff-wrap">
    <div class="diff-head">
      <button type="button" class="ghost" id="btn-load-diff">Refresh</button>
    </div>
    ${body}
  </div>`;
}

async function loadDiff() {
  if (!state.detail) return;
  state.diffLoading = true;
  renderDetail();
  try {
    state.diff = await Api.diff(state.detail.id);
  } catch (e) {
    state.diff = { raw: `Diff unavailable: ${e.message}` };
  } finally {
    state.diffLoading = false;
    renderDetail();
  }
}

function renderNotesTab(d) {
  const tasks = d.tasks || [];
  const notes = d.notes || [];
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");
  const taskRow = (t) => `<li class="note-item ${escapeAttr(t.status || "open")}" data-task="${escapeAttr(t.id)}">
        <button type="button" class="ghost note-check" data-toggle-task="${escapeAttr(t.id)}" title="Toggle">${t.status === "done" ? "☑" : "☐"}</button>
        <span>${escapeHtml(t.text)}</span>
        ${t.sourceMessageId ? `<button type="button" class="ghost" data-jump="${escapeAttr(t.sourceMessageId)}">Jump</button>` : ""}
        <button type="button" class="ghost" data-del-task="${escapeAttr(t.id)}" title="Delete">✕</button>
      </li>`;
  const noteRow = (n) => `<li class="note-item" data-note="${escapeAttr(n.id)}">
        <span class="dot"></span>
        <span>${escapeHtml(n.text)}</span>
        ${n.sourceMessageId ? `<button type="button" class="ghost" data-jump="${escapeAttr(n.sourceMessageId)}">Jump</button>` : ""}
        <button type="button" class="ghost" data-del-note="${escapeAttr(n.id)}" title="Delete">✕</button>
      </li>`;
  return `<div class="notes-wrap">
    <h4 class="section-h">Open (${open.length})</h4>
    ${open.length ? `<ul class="notes-list">${open.map(taskRow).join("")}</ul>` : `<p class="hint">No open todos. Right-click a message to capture one.</p>`}
    ${done.length ? `<h4 class="section-h">Done (${done.length})</h4><ul class="notes-list">${done.map(taskRow).join("")}</ul>` : ""}
    <h4 class="section-h">Notes (${notes.length})</h4>
    ${notes.length ? `<ul class="notes-list">${notes.map(noteRow).join("")}</ul>` : `<p class="hint">No notes yet.</p>`}
    <div class="note-add">
      <input id="task-draft" placeholder="Add a todo…" value="${escapeAttr(state.taskDraft || "")}" />
      <button type="button" class="secondary" id="btn-add-task">Add todo</button>
    </div>
    <div class="note-add">
      <input id="note-draft" placeholder="Add a note…" value="${escapeAttr(state.noteDraft || "")}" />
      <button type="button" class="secondary" id="btn-add-note">Add note</button>
    </div>
    <h4 class="section-h">Files (${(state.sessionFilesFor === d.id ? state.sessionFiles : []).length})</h4>
    ${renderFilesList(d)}
    <div class="note-add">
      <button type="button" class="secondary" id="btn-add-extra-dirs">Add folders…</button>
    </div>
  </div>`;
}

function renderFilesList(d) {
  const files = state.sessionFilesFor === d.id ? state.sessionFiles || [] : [];
  if (!files.length) {
    return `<p class="hint">No files yet. Tool paths, extra folders, and attachments show up here.</p>`;
  }
  return `<ul class="notes-list files-list">${files
    .map(
      (f) =>
        `<li class="note-item"><button type="button" class="ghost file-open" data-file-path="${escapeAttr(f.path)}" data-file-kind="${escapeAttr(f.kind || "file")}">${escapeHtml(f.title || f.path)}</button><span class="hint" title="${escapeAttr(f.path)}">${escapeHtml(shortPath(f.path))}</span></li>`,
    )
    .join("")}</ul>`;
}

function wireNotesTab(d) {
  const body = $("#tab-body");
  if (!body) return;
  body.querySelectorAll("[data-toggle-task]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-toggle-task");
      const task = (d.tasks || []).find((x) => x.id === id);
      if (!task) return;
      try {
        const next = await Api.updateTask(d.id, id, { status: task.status === "done" ? "open" : "done" });
        const i = d.tasks.findIndex((x) => x.id === id);
        if (i >= 0) d.tasks[i] = next.task || next;
        renderDetail();
      } catch (e) {
        banner(e.message, true);
      }
    });
  });
  body.querySelectorAll("[data-del-task]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await Api.deleteTask(d.id, btn.getAttribute("data-del-task"));
        d.tasks = (d.tasks || []).filter((x) => x.id !== btn.getAttribute("data-del-task"));
        renderDetail();
      } catch (e) {
        banner(e.message, true);
      }
    });
  });
  body.querySelectorAll("[data-del-note]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await Api.deleteNote(d.id, btn.getAttribute("data-del-note"));
        d.notes = (d.notes || []).filter((x) => x.id !== btn.getAttribute("data-del-note"));
        renderDetail();
      } catch (e) {
        banner(e.message, true);
      }
    });
  });
  body.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = "transcript";
      renderDetail();
      const el = document.getElementById(`msg-${btn.getAttribute("data-jump")}`);
      el?.scrollIntoView({ block: "center" });
    });
  });
  const addTask = async () => {
    const text = ($("#task-draft")?.value || "").trim();
    if (!text) return;
    try {
      const res = await Api.createTask(d.id, { text });
      d.tasks = [...(d.tasks || []), res.task || res];
      state.taskDraft = "";
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  };
  const addNote = async () => {
    const text = ($("#note-draft")?.value || "").trim();
    if (!text) return;
    try {
      const res = await Api.createNote(d.id, { text });
      d.notes = [...(d.notes || []), res.note || res];
      state.noteDraft = "";
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  };
  $("#btn-add-task")?.addEventListener("click", addTask);
  $("#btn-add-note")?.addEventListener("click", addNote);
  $("#task-draft")?.addEventListener("input", (e) => { state.taskDraft = e.target.value; });
  $("#note-draft")?.addEventListener("input", (e) => { state.noteDraft = e.target.value; });
  $("#task-draft")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTask(); } });
  $("#note-draft")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addNote(); } });
  body.querySelectorAll("[data-file-path]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openInViewer(btn.getAttribute("data-file-path"));
    });
  });
  $("#btn-add-extra-dirs")?.addEventListener("click", async () => {
    const dirs = (await window.clanker.pickDirectories?.()) || [];
    const extra = dirs.filter((p) => p && p !== d.cwd);
    if (!extra.length) return;
    try {
      const detail = await Api.addExtraDirs(d.id, extra);
      state.detail = { ...d, ...detail };
      state.sessionFilesFor = null;
      banner(`Added ${extra.length} folder(s)`);
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
}

// ——— Approval ———

function renderApprovalBar(pendingA) {
  const detailBits = [pendingA.kind, pendingA.detail || (pendingA.locations && pendingA.locations[0]?.path)]
    .filter(Boolean)
    .join(" · ");
  return `<div class="approval">
    <div class="approval-head">
      <strong>${escapeHtml(pendingA.title || "Approval needed")}</strong>
      ${pendingA.kind ? `<span class="approval-kind">${escapeHtml(pendingA.kind)}</span>` : ""}
    </div>
    ${detailBits ? `<p class="preview">${escapeHtml(detailBits)}</p>` : ""}
    <label class="field">Comment (optional)</label>
    <input id="approval-comment" placeholder="Reason or context…" value="${escapeAttr(state.approvalDraftComment || "")}" />
    <div class="inline-actions">
      <button type="button" class="primary" id="btn-approve">Approve <span class="kbd">↵</span></button>
      <button type="button" class="secondary" id="btn-approve-always">Approve always this session</button>
      <button type="button" class="danger" id="btn-reject">Reject <span class="kbd">Esc</span></button>
    </div>
  </div>`;
}

function wireApprovalControls(d, pendingA) {
  if (!pendingA) return;
  const commentEl = $("#approval-comment");
  if (commentEl) {
    commentEl.addEventListener("input", (e) => {
      state.approvalDraftComment = e.target.value;
    });
    // Focus so keyboard shortcuts work without clicking.
    setTimeout(() => commentEl.focus(), 0);
    commentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        approve("once");
      } else if (e.key === "Escape") {
        e.preventDefault();
        reject();
      }
    });
  }

  const approve = async (scope) => {
    try {
      state.detail = await Api.approve(d.id, {
        approvalId: pendingA.id,
        comment: state.approvalDraftComment || undefined,
        scope,
      });
      state.approvalDraftComment = "";
      trackHighestSeq(state.detail);
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  };
  const reject = async () => {
    try {
      state.detail = await Api.reject(d.id, {
        approvalId: pendingA.id,
        comment: state.approvalDraftComment || undefined,
      });
      state.approvalDraftComment = "";
      trackHighestSeq(state.detail);
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  };
  $("#btn-approve")?.addEventListener("click", () => approve("once"));
  $("#btn-approve-always")?.addEventListener("click", () => approve("always_session"));
  $("#btn-reject")?.addEventListener("click", reject);
}

function renderQuestionBar(pendingQ) {
  return `<div class="question">
    <strong>${escapeHtml(pendingQ.title || "Questions")}</strong>
    ${(pendingQ.questions || [])
      .map(
        (q, i) => `
      <label class="field">Q${i + 1}. ${escapeHtml(q.question)}</label>
      <select data-q="${i}">
        ${(q.options || [])
          .map((o) => `<option value="${escapeAttr(o.label)}">${escapeHtml(o.label)}</option>`)
          .join("")}
      </select>`,
      )
      .join("")}
    <div class="inline-actions">
      <button type="button" class="primary" id="btn-answer">Submit answers</button>
    </div>
  </div>`;
}

function wireQuestionControls(d, pendingQ) {
  if (!pendingQ) return;
  $("#btn-answer")?.addEventListener("click", async () => {
    const answers = [...document.querySelectorAll("select[data-q]")].map((s) => s.value);
    try {
      state.detail = await Api.answer(d.id, { questionId: pendingQ.id, answers });
      trackHighestSeq(state.detail);
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
}

// ——— Refresh / WS ———

async function refreshSessions() {
  if (!Api.getConnection().token) return;
  try {
    const [sessions, projects, profiles] = await Promise.all([
      Api.sessions(),
      Api.projects().catch(() => ({ projects: [] })),
      // Server ignores admin=1 for non-loopback callers; admin fields simply
      // don't come back over LAN/Tailscale.
      Api.profiles({ usage: true, admin: true }).catch(() => ({ profiles: [] })),
    ]);
    state.sessions = sessions.sessions || [];
    state.archived = sessions.archivedSessions || [];
    state.disk = sessions.diskSessions || [];
    state.claude = sessions.claudeSessions || [];
    state.agy = sessions.agySessions || [];
    state.projects = projects.projects || [];
    state.profiles = profiles.profiles || [];
    state.admin = profiles.admin === true;
    state.adminProfiles = profiles.adminProfiles || [];
    if (!state.profileId && state.profiles[0]) state.profileId = state.profiles[0].id;
    if (!state.enabledProfileIds.length) {
      state.enabledProfileIds = state.profiles.map((p) => p.id);
    } else {
      const known = new Set(state.profiles.map((p) => p.id));
      const kept = state.enabledProfileIds.filter((id) => known.has(id));
      const added = state.profiles.map((p) => p.id).filter((id) => !state.enabledProfileIds.includes(id) && !known.has(id));
      // Newly appeared profiles join the all-on set only when we were already showing all.
      if (showsAllProfiles()) state.enabledProfileIds = state.profiles.map((p) => p.id);
      else state.enabledProfileIds = kept;
    }
    renderProfiles();
    renderActiveHostChip();
    if (state.nav === "sessions") {
      renderSessionList();
      if (state.selectedId) {
        try {
          state.detail = await Api.session(state.selectedId);
          trackHighestSeq(state.detail);
          renderDetail();
        } catch {
          /* session gone */
        }
      }
    } else if (state.nav === "grok" || state.nav === "claude") {
      renderDisk(state.nav);
    } else if (state.nav === "projects") {
      renderProjects();
    } else if (state.nav === "tasks") {
      renderTasks();
    }
    // Compose intentionally NOT re-rendered here — the poll would clobber
    // focus/selection while the user is mid-type. Compose only needs a
    // fresh render on nav enter, on profile change, or after add-folder,
    // all of which already call renderCompose() explicitly.
  } catch (e) {
    if (state.nav === "sessions") {
      $("#session-list").innerHTML = `<div class="list-empty">${escapeHtml(e.message)}</div>`;
    }
  }
}

function trackHighestSeq(detail) {
  if (!detail?.id) return;
  const events = detail.events || [];
  const highest = events.reduce((m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m), 0);
  const stored = state.lastSeqBySession[detail.id] || 0;
  state.lastSeqBySession[detail.id] = Math.max(stored, highest);
}

async function catchUpEvents(sessionId) {
  if (!sessionId || !Api.getConnection().token) return;
  const since = state.lastSeqBySession[sessionId] || 0;
  try {
    const r = await Api.events(sessionId, since);
    const events = r?.events || [];
    for (const ev of events) applyEvent(ev, { fromReplay: true });
    if (state.selectedId === sessionId) {
      try {
        state.detail = await Api.session(sessionId);
        trackHighestSeq(state.detail);
        renderDetail();
      } catch {
        /* */
      }
    }
  } catch (e) {
    console.warn("[replay]", e);
  }
}

function applyEvent(ev, { fromReplay = false } = {}) {
  if (!ev || !ev.type) return;
  const sid = ev.sessionId;
  if (sid && typeof ev.seq === "number") {
    const prev = state.lastSeqBySession[sid] || 0;
    if (ev.seq <= prev) return;
    state.lastSeqBySession[sid] = ev.seq;
  }

  patchSessionListMeta(sid, ev);

  if (state.selectedId && sid === state.selectedId && state.detail) {
    patchOpenDetail(ev);
    if (!fromReplay) renderDetail();

    // Reconcile on turn boundaries. The live WS path sometimes drops the
    // final `transcript` entry (host emits before persist flush, or shape
    // mismatch in a backend path), so the last message only appears after
    // the user navigates away + back. When the server tells us the session
    // has gone idle or completed, fetch the authoritative detail once so
    // the transcript matches disk without requiring a nav round-trip.
    const wentIdle =
      ev.type === "session.completed" ||
      (ev.type === "session.updated" &&
        ["idle", "completed"].includes(ev.payload?.status));
    if (wentIdle && !fromReplay) {
      const targetId = sid;
      setTimeout(async () => {
        if (state.selectedId !== targetId) return;
        try {
          const fresh = await Api.session(targetId);
          if (state.selectedId !== targetId) return;
          state.detail = fresh;
          trackHighestSeq(fresh);
          renderDetail();
        } catch {
          /* session might be gone — ignore */
        }
      }, 300);
    }
  }

  if (["session.created", "session.updated", "session.completed", "session.failed"].includes(ev.type)) {
    if (state.nav === "sessions" && (!state.selectedId || sid !== state.selectedId)) {
      renderSessionList();
    }
  }
  if (String(ev.type || "").startsWith("task.") && state.nav === "tasks") renderTasks();

  // Bots list is derived from bot-backend sessions — quiet-reload lastRunAt/lastSessionId
  // when any bot session transitions state or is newly created.
  if (["session.created", "session.updated", "session.completed", "session.failed"].includes(ev.type)) {
    const sess = ev.payload?.session || (idx => state.sessions[idx])(state.sessions.findIndex((s) => s.id === sid));
    const isBot = (sess?.backend === "bot") || (ev.payload?.backend === "bot");
    if (isBot && state.nav === "bots") {
      loadBots({ preserveSelection: true }).then(() => renderBots()).catch(() => {});
    }
  }
}

function patchSessionListMeta(sid, ev) {
  if (!sid) return;
  const idx = state.sessions.findIndex((s) => s.id === sid);
  if (idx === -1 && ev.type !== "session.created") return;

  if (ev.type === "session.created" && ev.payload?.session) {
    if (idx === -1) state.sessions.unshift(ev.payload.session);
  }
  if (ev.type === "session.updated") {
    const patch = ev.payload || {};
    if (idx !== -1) Object.assign(state.sessions[idx], patch);
  }
  if (ev.type === "session.completed") {
    if (idx !== -1) state.sessions[idx].status = ev.payload?.status || "completed";
  }
  if (ev.type === "session.failed") {
    if (idx !== -1) {
      state.sessions[idx].status = "failed";
      state.sessions[idx].error = ev.payload?.error;
    }
  }
  if (ev.type === "approval.needed") {
    if (idx !== -1) state.sessions[idx].status = "awaiting_approval";
  }
  if (ev.type === "approval.resolved") {
    if (idx !== -1 && state.sessions[idx].status === "awaiting_approval") {
      state.sessions[idx].status = "running";
    }
  }
  if (ev.type === "question.needed") {
    if (idx !== -1) state.sessions[idx].status = "awaiting_question";
  }
}

function patchOpenDetail(ev) {
  const d = state.detail;
  if (!d) return;
  const payload = ev.payload || {};

  switch (ev.type) {
    case "transcript": {
      if (payload.streaming) {
        if (payload.text) state.streamingText = (state.streamingText || "") + payload.text;
        break;
      }
      if (payload.id && !(d.transcript || []).some((e) => e.id === payload.id)) {
        d.transcript = [...(d.transcript || []), payload];
      }
      state.streamingText = "";
      break;
    }
    case "thought": {
      // Accumulate streaming thought/text into the streaming buffer so it flows
      // in at the bottom until a completed transcript entry arrives.
      if (payload.text) state.streamingText = (state.streamingText || "") + payload.text;
      break;
    }
    case "tool_call": {
      const tc = payload;
      if (!tc?.toolCallId) break;
      const list = d.toolCalls || [];
      const i = list.findIndex((t) => t.toolCallId === tc.toolCallId);
      if (i >= 0) list[i] = { ...list[i], ...tc };
      else list.push(tc);
      d.toolCalls = list;
      break;
    }
    case "tool_call_update": {
      const upd = payload;
      if (!upd?.toolCallId) break;
      const list = d.toolCalls || [];
      const i = list.findIndex((t) => t.toolCallId === upd.toolCallId);
      if (i >= 0) list[i] = { ...list[i], ...upd };
      d.toolCalls = list;
      break;
    }
    case "plan": {
      if (Array.isArray(payload.entries)) d.plan = payload.entries;
      break;
    }
    case "approval.needed": {
      d.pendingApproval = payload;
      d.status = "awaiting_approval";
      break;
    }
    case "approval.resolved": {
      d.pendingApproval = null;
      if (d.status === "awaiting_approval") d.status = "running";
      break;
    }
    case "question.needed": {
      d.pendingQuestion = payload;
      d.status = "awaiting_question";
      break;
    }
    case "question.answered": {
      d.pendingQuestion = null;
      break;
    }
    case "session.updated": {
      Object.assign(d, payload || {});
      if (["idle", "completed", "failed", "cancelled"].includes(String(payload.status || ""))) {
        state.streamingText = "";
      }
      break;
    }
    case "session.completed": {
      d.status = payload.status || "completed";
      state.streamingText = "";
      break;
    }
    case "session.failed": {
      d.status = "failed";
      d.error = payload.error;
      state.streamingText = "";
      break;
    }
    case "usage": {
      d.usage = payload;
      break;
    }
    case "task.created": {
      d.tasks = [...(d.tasks || []), payload];
      break;
    }
    case "task.updated": {
      const i = (d.tasks || []).findIndex((t) => t.id === payload.id);
      if (i >= 0) d.tasks[i] = payload;
      break;
    }
    case "task.deleted": {
      d.tasks = (d.tasks || []).filter((t) => t.id !== payload.taskId);
      break;
    }
    case "note.created": {
      d.notes = [...(d.notes || []), payload];
      break;
    }
    case "note.updated": {
      const i = (d.notes || []).findIndex((n) => n.id === payload.id);
      if (i >= 0) d.notes[i] = payload;
      break;
    }
    case "note.deleted": {
      d.notes = (d.notes || []).filter((n) => n.id !== payload.noteId);
      break;
    }
    case "diff": {
      // Diff comes as a content chunk — invalidate the cached full-session diff.
      state.diff = null;
      break;
    }
    default:
      break;
  }
}


function closeMenuPops() {
  document.querySelectorAll(".menu-pop").forEach((el) => el.remove());
}

function placeMenu(anchor, html) {
  closeMenuPops();
  const menu = document.createElement("div");
  menu.className = "menu-pop";
  menu.innerHTML = html;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onEsc, true);
  };
  const onDoc = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onEsc = (e) => {
    if (e.key === "Escape") close();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onEsc, true);
  }, 0);
  return { menu, close };
}

function wireSessionMenu(d) {
  const btn = $("#btn-session-menu");
  if (!btn) return;
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const others = state.profiles.filter((p) => p.id && p.id !== d.profileId);
    const projects = (state.projects || []).filter((p) => !p.archived);
    const transferItems = others
      .map(
        (p) =>
          `<button type="button" class="menu-item" data-act="transfer" data-pid="${escapeAttr(p.id)}"><span class="menu-name">Transfer to ${escapeHtml(p.name)}</span></button>`,
      )
      .join("");
    const reviewItems = state.profiles
      .map(
        (p) =>
          `<button type="button" class="menu-item" data-act="review" data-pid="${escapeAttr(p.id)}"><span class="menu-name">Review as ${escapeHtml(p.name)}</span></button>`,
      )
      .join("");
    const projectItems =
      projects
        .map(
          (p) =>
            `<button type="button" class="menu-item ${p.id === d.projectId ? "active" : ""}" data-act="project" data-pid="${escapeAttr(p.id)}"><span class="menu-name">${escapeHtml(p.name)}</span></button>`,
        )
        .join("") +
      (d.projectId
        ? `<button type="button" class="menu-item" data-act="project" data-pid=""><span class="menu-name">Detach project</span></button>`
        : "");
    const { menu, close } = placeMenu(
      btn,
      `
      <button type="button" class="menu-item" data-act="rename"><span class="menu-name">Rename…</span></button>
      <button type="button" class="menu-item" data-act="close"><span class="menu-name">Close as done</span></button>
      <button type="button" class="menu-item" data-act="cancel"><span class="menu-name">Cancel session</span></button>
      <div class="menu-sep"></div>
      ${transferItems ? transferItems + `<div class="menu-sep"></div>` : ""}
      <button type="button" class="menu-item" data-act="reincarnate"><span class="menu-name">Reincarnate…</span></button>
      ${reviewItems ? reviewItems + `<div class="menu-sep"></div>` : ""}
      ${projectItems ? projectItems + `<div class="menu-sep"></div>` : ""}
      ${
        d.archived
          ? `<button type="button" class="menu-item" data-act="unarchive"><span class="menu-name">Unarchive</span></button>`
          : `<button type="button" class="menu-item" data-act="archive"><span class="menu-name">Archive</span></button>`
      }
      <button type="button" class="menu-item" data-act="delete"><span class="menu-name" style="color:var(--danger)">Delete permanently…</span></button>
    `,
    );
    menu.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", async () => {
        const act = el.getAttribute("data-act");
        const pid = el.getAttribute("data-pid");
        close();
        try {
          if (act === "rename") {
            const title = prompt("Session title", d.title || "");
            if (!title) return;
            state.detail = await Api.renameSession(d.id, title);
          } else if (act === "close") {
            await Api.close(d.id);
            banner("Closed as done");
            state.detail = null;
            state.selectedId = null;
            await refreshSessions();
            renderDetail();
            return;
          } else if (act === "cancel") {
            state.detail = await Api.cancel(d.id);
          } else if (act === "transfer") {
            if (!confirm(`Transfer this session to another profile?`)) return;
            state.detail = await Api.transferSession(d.id, pid);
            banner("Transferred");
          } else if (act === "reincarnate") {
            if (!confirm("Archive this chat and start a fresh session with a transcript summary?")) return;
            const next = await Api.reincarnateSession(d.id, { profileId: state.profileId || undefined });
            banner("Reincarnated");
            await refreshSessions();
            openSession(next.id);
            return;
          } else if (act === "review") {
            const next = await Api.reviewSession(d.id, { profileId: pid, includeDiff: true });
            banner("Review session started");
            await refreshSessions();
            openSession(next.id);
            return;
          } else if (act === "project") {
            state.detail = await Api.setSessionProject(d.id, pid || null);
          } else if (act === "archive") {
            await Api.archive(d.id);
            banner("Archived");
            state.detail = null;
            state.selectedId = null;
            await refreshSessions();
            renderDetail();
            return;
          } else if (act === "unarchive") {
            state.detail = await Api.unarchive(d.id);
            banner("Restored");
          } else if (act === "delete") {
            if (!confirm("Permanently delete this session and its attachments?")) return;
            await Api.deleteSession(d.id);
            banner("Deleted");
            state.detail = null;
            state.selectedId = null;
            await refreshSessions();
            renderDetail();
            return;
          }
          trackHighestSeq(state.detail);
          await refreshSessions();
          renderDetail();
        } catch (e) {
          banner(e.message, true);
        }
      });
    });
  });
}

async function startProfileLogin(d) {
  const profileId = d.profileId || state.profileId;
  if (!profileId) {
    banner("No profile id on this session", true);
    return;
  }
  try {
    const res = await Api.loginProfile(profileId);
    if (res.ok === false) {
      banner(res.error || "Login failed", true);
      return;
    }
    state.loginAckedFor = `${d.id}:${d.updatedAt || ""}`;
    banner(res.message || "Browser opened on host — finish sign-in there.");
    renderDetail();
  } catch (e) {
    banner(e.message, true);
  }
}


function wireTranscriptCapture(d) {
  if (!d) return;
  document.querySelectorAll("#transcript [data-msg]").forEach((el) => {
    el.addEventListener("contextmenu", (e) => {
      const mid = el.getAttribute("data-msg");
      if (!mid) return;
      e.preventDefault();
      const text = el.querySelector(".text")?.textContent || "";
      const { menu, close } = placeMenu(el, `
        <button type="button" class="menu-item" data-cap="todo"><span class="menu-name">Save as todo</span></button>
        <button type="button" class="menu-item" data-cap="note"><span class="menu-name">Save as note</span></button>
      `);
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      menu.querySelectorAll("[data-cap]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const kind = btn.getAttribute("data-cap");
          close();
          const edited = prompt(kind === "todo" ? "Todo text" : "Note text", text);
          if (!edited) return;
          try {
            if (kind === "todo") {
              const res = await Api.createTask(d.id, { text: edited, sourceMessageId: mid });
              d.tasks = [...(d.tasks || []), res.task || res];
              banner("Saved todo");
            } else {
              const res = await Api.createNote(d.id, { text: edited, sourceMessageId: mid });
              d.notes = [...(d.notes || []), res.note || res];
              banner("Saved note");
            }
            if (state.tab === "notes") renderDetail();
          } catch (err) {
            banner(err.message, true);
          }
        });
      });
    });
  });
}

// ——— Compose ———

function renderCompose() {
  const root = $("#view-compose");
  const draft = state.composeDraft;
  const live = [...(root.querySelectorAll("input, textarea, select") || [])];
  if (live.length) {
    draft.title = $("#c-title")?.value ?? draft.title;
    draft.prompt = $("#c-prompt")?.value ?? draft.prompt;
    draft.projectId = $("#c-project")?.value ?? draft.projectId;
    draft.cwd = $("#c-cwd")?.value ?? draft.cwd;
    draft.planMode = $("#c-plan")?.checked ?? draft.planMode;
    draft.worktree = $("#c-wt")?.checked ?? draft.worktree;
    draft.subagents = $("#c-sub")?.checked ?? draft.subagents;
  }
  // Capture focus + caret so a mid-type re-render (add-folder callback,
  // profile switch) doesn't bump the user out of the textarea.
  const activeEl = document.activeElement;
  const focusedId = activeEl && root.contains(activeEl) && activeEl.id ? activeEl.id : null;
  const focusedSelStart = focusedId && typeof activeEl.selectionStart === "number" ? activeEl.selectionStart : null;
  const focusedSelEnd = focusedId && typeof activeEl.selectionEnd === "number" ? activeEl.selectionEnd : null;
  const profile = state.profiles.find((p) => p.id === state.profileId);
  const grok = isGrokBackend(profile?.backend);
  const isBot = profile?.backend === "bot";
  const opts = (state.projects || [])
    .filter((p) => !p.archived)
    .map((p) => {
      const path = projectPrimaryPath(p);
      const sel = (draft.projectId || "") === p.id ? "selected" : "";
      return `<option value="${escapeAttr(p.id)}" ${sel}>${escapeHtml(p.name)} — ${escapeHtml(path)}</option>`;
    })
    .join("");
  root.innerHTML = `
    <div class="compose-grid">
      <div class="card">
        <h3>Dispatch a task</h3>
        <p class="hint">Runs on the host machine under ${escapeHtml(profile?.name || "default profile")}${profile?.backend ? ` · ${escapeHtml(profile.backend)}` : ""}.${isBot ? " This is a hunter bot: dispatch opens a normal session — review the transcript and approve outbound drafts there. Nothing is sent." : ""}</p>
        <label class="field">Project</label>
        <div class="row-inline">
          <select id="c-project"><option value="">—</option>${opts}</select>
          <button type="button" class="secondary" id="c-add-folder">Add folder…</button>
        </div>
        <label class="field">Custom cwd (optional)</label>
        <input id="c-cwd" placeholder="/absolute/path when host allows custom paths" value="${escapeAttr(draft.cwd || "")}" />
        <label class="field">Extra folders</label>
        <div class="row-inline">
          <button type="button" class="secondary" id="c-extra-folders">Pick extra folders…</button>
        </div>
        <ul class="notes-list" id="c-extra-list">${(draft.extraDirs || [])
          .map(
            (dir, i) =>
              `<li class="note-item"><span>${escapeHtml(dir)}</span><button type="button" class="ghost" data-rm-extra="${i}">✕</button></li>`,
          )
          .join("")}</ul>
        <label class="field">Title (optional)</label>
        <input id="c-title" placeholder="Short name" value="${escapeAttr(draft.title || "")}" />
        <label class="field">Prompt</label>
        <textarea id="c-prompt" placeholder="What should the agent do?">${escapeHtml(draft.prompt || "")}</textarea>
        <label class="field">Screenshots (optional, max 4)</label>
        <div class="img-row" id="c-img-row">
          ${(draft.images || []).map((im, i) =>
            `<span class="img-thumb"><img src="data:${escapeAttr(im.mimeType)};base64,${escapeAttr(im.data)}" alt=""/><button type="button" class="img-x" data-rm-compose-img="${i}">×</button></span>`
          ).join("")}
        </div>
        <div class="row-inline">
          <button type="button" class="secondary" id="c-attach-img">Attach images…</button>
        </div>
        ${grok ? `<label class="check"><input type="checkbox" id="c-plan" ${draft.planMode !== false ? "checked" : ""}/> Plan mode</label>
        <label class="check"><input type="checkbox" id="c-wt" ${draft.worktree !== false ? "checked" : ""}/> Worktree</label>` : `<p class="hint">Plan mode / worktree are Grok ACP flags — hidden for ${escapeHtml(profile?.backend || "this backend")}.</p>`}
        <label class="check"><input type="checkbox" id="c-sub" ${draft.subagents !== false ? "checked" : ""}/> Subagents</label>
        <div class="inline-actions">
          <button type="button" class="primary" id="c-go">Spank a clanker</button>
        </div>
      </div>
    </div>`;
  const persist = () => {
    state.composeDraft = {
      title: $("#c-title")?.value || "",
      prompt: $("#c-prompt")?.value || "",
      projectId: $("#c-project")?.value || "",
      cwd: $("#c-cwd")?.value || "",
      planMode: $("#c-plan") ? $("#c-plan").checked : state.composeDraft.planMode,
      worktree: $("#c-wt") ? $("#c-wt").checked : state.composeDraft.worktree,
      subagents: $("#c-sub")?.checked !== false,
      images: state.composeDraft.images || [],
      extraDirs: state.composeDraft.extraDirs || [],
    };
  };
  root.querySelectorAll("input, textarea, select").forEach((el) => {
    el.addEventListener("input", persist);
    el.addEventListener("change", persist);
  });
  $("#c-project")?.addEventListener("change", () => {
    const p = state.projects.find((x) => x.id === $("#c-project").value);
    if (p?.defaultProfileId) {
      state.profileId = p.defaultProfileId;
      renderProfiles();
    }
  });
  $("#c-extra-folders")?.addEventListener("click", async () => {
    persist();
    const dirs = (await window.clanker.pickDirectories?.()) || [];
    const cwd = (state.composeDraft.cwd || "").trim();
    const extra = dirs.filter((p) => p && p !== cwd);
    if (!extra.length) return;
    const have = new Set(state.composeDraft.extraDirs || []);
    state.composeDraft.extraDirs = [...(state.composeDraft.extraDirs || [])];
    for (const dir of extra) {
      if (!have.has(dir)) {
        have.add(dir);
        state.composeDraft.extraDirs.push(dir);
      }
    }
    renderCompose();
  });
  root.querySelectorAll("[data-rm-extra]").forEach((btn) => {
    btn.addEventListener("click", () => {
      persist();
      const i = Number(btn.getAttribute("data-rm-extra"));
      (state.composeDraft.extraDirs || []).splice(i, 1);
      renderCompose();
    });
  });
  $("#c-add-folder")?.addEventListener("click", async () => {
    const dir = await window.clanker.pickDirectory();
    if (!dir) return;
    try {
      const created = await Api.createProject({
        name: dir.split("/").pop() || "Project",
        paths: [dir],
      });
      const proj = created.project || created;
      banner(`Added ${dir}`);
      await refreshSessions();
      state.composeDraft.projectId = proj.id;
      state.composeDraft.cwd = dir;
      renderCompose();
    } catch (e) {
      banner(e.message, true);
    }
  });
  if (isBot && !(draft.prompt || "").trim()) {
    Api.request("/bots")
      .then((res) => {
        const bot = (res.bots || []).find((b) => b.profileId === state.profileId) || (res.bots || [])[0];
        if (!bot) return;
        const ta = $("#c-prompt");
        if (ta && !ta.value.trim()) {
          ta.value = bot.job;
          persist();
        }
        const sel = $("#c-project");
        if (sel && [...sel.options].some((o) => o.value === bot.projectId)) {
          sel.value = bot.projectId;
          persist();
        }
      })
      .catch(() => undefined);
  }
  // Restore focus + caret if user was typing before the re-render.
  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el) {
      try {
        el.focus({ preventScroll: true });
        if (focusedSelStart !== null && typeof el.setSelectionRange === "function") {
          el.setSelectionRange(focusedSelStart, focusedSelEnd ?? focusedSelStart);
        }
      } catch {
        /* focus may fail on select/checkbox — safe to ignore */
      }
    }
  }
  $("#c-attach-img")?.addEventListener("click", async () => {
    persist();
    const files = await window.clanker.pickFiles({ images: true });
    if (!files?.length) return;
    const room = Math.max(0, 4 - (state.composeDraft.images || []).length);
    state.composeDraft.images = [...(state.composeDraft.images || []), ...files.slice(0, room)];
    renderCompose();
  });
  root.querySelectorAll("[data-rm-compose-img]").forEach((btn) => {
    btn.addEventListener("click", () => {
      persist();
      const i = Number(btn.getAttribute("data-rm-compose-img"));
      (state.composeDraft.images || []).splice(i, 1);
      renderCompose();
    });
  });
  $("#c-go")?.addEventListener("click", async () => {
    persist();
    const prompt = state.composeDraft.prompt.trim();
    const images = state.composeDraft.images || [];
    if (!prompt && !images.length) {
      banner("Write a prompt first", true);
      return;
    }
    try {
      const body = {
        prompt:
          prompt ||
          (images.length === 1
            ? "Please review this screenshot for debugging."
            : `Please review these ${images.length} screenshots for debugging.`),
        projectId: state.composeDraft.projectId || undefined,
        cwd: state.composeDraft.cwd.trim() || undefined,
        extraDirs: (state.composeDraft.extraDirs || []).filter((p) => p && p !== state.composeDraft.cwd.trim()),
        title: state.composeDraft.title.trim() || undefined,
        subagents: state.composeDraft.subagents,
        profileId: state.profileId || undefined,
      };
      if (images.length) body.images = images;
      if (grok) {
        body.planMode = state.composeDraft.planMode;
        body.worktree = state.composeDraft.worktree;
      }
      const detail = await Api.dispatch(body);
      banner("Dispatched");
      state.composeDraft.prompt = "";
      state.composeDraft.title = "";
      state.composeDraft.images = [];
      state.composeDraft.extraDirs = [];
      await refreshSessions();
      setNav("sessions");
      openSession(detail.id);
    } catch (e) {
      banner(e.message, true);
    }
  });
}

// ——— Disk sessions ———

function renderDisk(kind) {
  const root = $("#view-disk");
  const rows = kind === "claude" ? state.claude : kind === "agy" ? state.agy || [] : state.disk;
  if (!rows.length) {
    const label = kind === "claude" ? "Claude" : kind === "agy" ? "Gemini CLI" : "Grok";
    root.innerHTML = `<div class="list-empty">No ${label} sessions on disk.</div>`;
    return;
  }
  root.innerHTML = `<div class="stack-gap" style="max-width:720px">${rows
    .map((d) => {
      if (kind === "agy") {
        return `<article class="card">
          <h3>${escapeHtml(d.title || d.id.slice(0, 8))}</h3>
          <div class="meta"><span>${escapeHtml(shortPath(d.cwd || ""))}</span></div>
          <div class="inline-actions">
            <button type="button" class="primary" data-attach-agy="${escapeAttr(d.id)}" data-cwd="${escapeAttr(d.cwd || "")}" data-title="${escapeAttr(d.title || "")}">Resume Gemini CLI</button>
          </div>
        </article>`;
      }
      if (kind === "claude") {
        return `<article class="card">
          <h3>${escapeHtml(d.title || d.id.slice(0, 8))}</h3>
          <div class="meta"><span>${escapeHtml(shortPath(d.cwd || ""))}</span></div>
          <div class="inline-actions">
            <button type="button" class="primary" data-attach-claude="${escapeAttr(d.id)}" data-cwd="${escapeAttr(d.cwd || "")}" data-title="${escapeAttr(d.title || "")}" data-path="${escapeAttr(d.transcriptPath || "")}">Resume Claude</button>
            <button type="button" class="secondary" data-attach-claude-grok="${escapeAttr(d.id)}" data-cwd="${escapeAttr(d.cwd || "")}" data-title="${escapeAttr(d.title || "")}" data-path="${escapeAttr(d.transcriptPath || "")}">→ Grok</button>
          </div>
        </article>`;
      }
      return `<article class="card">
        <h3>${escapeHtml(d.title || d.id.slice(0, 8))}</h3>
        <div class="meta"><span>${escapeHtml(shortPath(d.cwd || ""))}</span></div>
        <div class="inline-actions">
          <button type="button" class="primary" data-attach-grok="${escapeAttr(d.id)}" data-cwd="${escapeAttr(d.cwd || "")}" data-title="${escapeAttr(d.title || "")}">Open in Dispatch</button>
        </div>
      </article>`;
    })
    .join("")}</div>`;

  root.querySelectorAll("[data-attach-grok]").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        const detail = await Api.attachGrok({
          grokSessionId: el.getAttribute("data-attach-grok"),
          cwd: el.getAttribute("data-cwd"),
          title: el.getAttribute("data-title") || undefined,
        });
        banner("Attached Grok session");
        await refreshSessions();
        setNav("sessions");
        openSession(detail.id);
      } catch (e) {
        banner(e.message, true);
      }
    });
  });
  root.querySelectorAll("[data-attach-agy]").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        const detail = await Api.attachAgy({
          conversationId: el.getAttribute("data-attach-agy"),
          cwd: el.getAttribute("data-cwd"),
          title: el.getAttribute("data-title") || undefined,
          profileId: state.profileId || undefined,
        });
        banner("Attached Gemini CLI conversation");
        await refreshSessions();
        setNav("sessions");
        openSession(detail.id);
      } catch (e) {
        banner(e.message, true);
      }
    });
  });
  root.querySelectorAll("[data-attach-claude]").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        const detail = await Api.attachClaude({
          claudeSessionId: el.getAttribute("data-attach-claude"),
          cwd: el.getAttribute("data-cwd"),
          title: el.getAttribute("data-title") || undefined,
          mode: "resume-claude",
          transcriptPath: el.getAttribute("data-path") || undefined,
          profileId: state.profileId || undefined,
        });
        banner("Resumed Claude");
        await refreshSessions();
        setNav("sessions");
        openSession(detail.id);
      } catch (e) {
        banner(e.message, true);
      }
    });
  });
  root.querySelectorAll("[data-attach-claude-grok]").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        const detail = await Api.attachClaude({
          claudeSessionId: el.getAttribute("data-attach-claude-grok"),
          cwd: el.getAttribute("data-cwd"),
          title: el.getAttribute("data-title") || undefined,
          mode: "continue-with-grok",
          transcriptPath: el.getAttribute("data-path") || undefined,
          profileId: state.profileId || undefined,
        });
        banner("Continued with Grok");
        await refreshSessions();
        setNav("sessions");
        openSession(detail.id);
      } catch (e) {
        banner(e.message, true);
      }
    });
  });
}


function wireOpenPaths(d) {
  document.querySelectorAll("[data-open-path]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const raw = el.getAttribute("data-open-path");
      if (!raw) return;
      openInViewer(resolveFsPath(raw, d?.cwd || ""));
    });
  });
}

async function openInViewer(path) {
  state.showViewer = true;
  state.viewerPath = path;
  syncViewerPane();
  await loadViewer(path);
}

function syncViewerPane() {
  const pane = $("#file-viewer");
  if (!pane) return;
  const show = state.nav === "sessions" && state.showViewer;
  pane.classList.toggle("hidden", !show);
  $("#view-sessions")?.classList.toggle("with-viewer", show);
  const btn = $("#btn-viewer");
  if (btn) btn.classList.toggle("active-tool", state.showViewer);
}

async function loadViewer(path) {
  const pane = $("#file-viewer");
  if (!pane) return;
  const current = path || state.viewerPath || "";
  pane.innerHTML = `
    <div class="viewer-head">
      <input id="viewer-path" class="search-input" placeholder="Path (e.g. ~/Projects/foo/README.md)" value="${escapeAttr(current)}" />
      <button type="button" class="ghost" id="viewer-go">Open</button>
      <button type="button" class="ghost" id="viewer-browse">Browse</button>
      <button type="button" class="ghost" id="viewer-reveal">Reveal</button>
      <button type="button" class="ghost" id="viewer-hide">Hide</button>
    </div>
    <iframe id="viewer-frame" class="viewer-frame" sandbox="" title="File preview"></iframe>`;
  const frame = $("#viewer-frame");
  const run = async (p) => {
    state.viewerPath = p;
    const res = await window.clanker.readLocalFile(p);
    if (res?.ok) {
      frame.srcdoc = FileViewer.render(res);
      return;
    }
    if (state.detail?.id) {
      try {
        const remote = await Api.sessionFile(state.detail.id, p);
        const ext = String(remote.name || p)
          .split(".")
          .pop();
        frame.srcdoc = FileViewer.render({
          path: remote.path,
          filename: remote.name,
          ext,
          text: remote.text,
          dataUrl: remote.data ? `data:${remote.mimeType};base64,${remote.data}` : undefined,
          binary: remote.binary,
        });
        return;
      } catch (err) {
        frame.srcdoc = FileViewer.error(err.message || res?.error || "Unreadable");
        return;
      }
    }
    frame.srcdoc = FileViewer.error(res?.error || "Unreadable");
  };
  $("#viewer-go")?.addEventListener("click", () => run($("#viewer-path").value.trim()));
  $("#viewer-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run($("#viewer-path").value.trim());
    }
  });
  $("#viewer-browse")?.addEventListener("click", async () => {
    const files = await window.clanker.pickFiles({});
    if (files?.[0]?.path) {
      $("#viewer-path").value = files[0].path;
      await run(files[0].path);
    }
  });
  $("#viewer-reveal")?.addEventListener("click", () => {
    const p = $("#viewer-path")?.value.trim();
    if (p) window.clanker.showPath(p);
  });
  $("#viewer-hide")?.addEventListener("click", () => {
    state.showViewer = false;
    syncViewerPane();
  });
  if (current) await run(current);
  else if (frame) frame.srcdoc = FileViewer.welcome();
}

async function renderProjects() {
  const root = $("#view-projects");
  if (!root) return;
  const q = state.projectSearch.trim().toLowerCase();
  const rows = (state.projects || []).filter((p) => !p.archived);
  const filtered = q
    ? rows.filter((p) => [p.name, projectPrimaryPath(p), ...(p.paths || [])].join(" ").toLowerCase().includes(q))
    : rows;
  root.innerHTML = `
    <div class="list-chrome">
      <div class="row-inline">
        <input id="project-search" class="search-input" placeholder="Search projects" value="${escapeAttr(state.projectSearch)}" />
        <button type="button" class="primary" id="p-new">New project</button>
        <button type="button" class="secondary" id="p-discover">Discover</button>
      </div>
    </div>
    <div class="stack-gap" style="max-width:820px">${
      filtered.length
        ? filtered
            .map((p) => {
              const paths = (p.paths && p.paths.length ? p.paths : [p.path]).filter(Boolean);
              const atts = p.attachments || [];
              return `<article class="card project-card" data-open-project="${escapeAttr(p.id)}">
                <h3><span class="dot" style="background:${escapeAttr(p.color || "#73b8ff")}"></span> ${escapeHtml(p.name)}</h3>
                <div class="meta">${paths.map((x) => `<span>${escapeHtml(shortPath(x))}</span>`).join("")}${p.defaultProfileId ? `<span>default ${escapeHtml(p.defaultProfileId)}</span>` : ""}</div>
                ${atts.length ? `<div class="meta">${atts.map((a) => `<span>${escapeHtml(a.originalName || a.filename || a.id)} <button type="button" class="ghost" data-del-att="${escapeAttr(p.id)}" data-att="${escapeAttr(a.id)}">✕</button></span>`).join("")}</div>` : ""}
                <div class="inline-actions">
                  <button type="button" class="secondary" data-compose-project="${escapeAttr(p.id)}">Compose</button>
                  <button type="button" class="ghost" data-edit-project="${escapeAttr(p.id)}">Edit</button>
                  <button type="button" class="ghost" data-attach-project="${escapeAttr(p.id)}">Attach file</button>
                  <button type="button" class="danger" data-del-project="${escapeAttr(p.id)}">Archive</button>
                </div>
              </article>`;
            })
            .join("")
        : `<div class="list-empty">No projects yet. Create one or run Discover.</div>`
    }</div>`;
  $("#project-search")?.addEventListener("input", (e) => {
    state.projectSearch = e.target.value;
    renderProjects();
  });
  $("#p-new")?.addEventListener("click", () => editProject(null));
  $("#p-discover")?.addEventListener("click", async () => {
    try {
      const res = await Api.discoverProjects();
      const cands = res.projects || [];
      if (!cands.length) {
        banner("No new folders discovered");
        return;
      }
      const pick = cands
        .map((c, i) => `${i + 1}. ${c.name} — ${projectPrimaryPath(c)}`)
        .join("\n");
      const raw = prompt(`Import which? Enter numbers comma-separated:\n${pick}`);
      if (!raw) return;
      const idxs = raw.split(",").map((s) => Number(s.trim()) - 1).filter((n) => n >= 0 && n < cands.length);
      for (const i of idxs) {
        const c = cands[i];
        await Api.createProject({
          name: c.name,
          paths: c.paths || [c.path],
          color: c.color,
        });
      }
      banner(`Imported ${idxs.length}`);
      await refreshSessions();
      renderProjects();
    } catch (e) {
      banner(e.message, true);
    }
  });
  root.querySelectorAll("[data-compose-project]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.composeDraft.projectId = btn.getAttribute("data-compose-project");
      setNav("compose");
    });
  });
  root.querySelectorAll("[data-edit-project]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const proj = state.projects.find((x) => x.id === btn.getAttribute("data-edit-project"));
      editProject(proj || null);
    });
  });
  root.querySelectorAll("[data-del-project]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Archive this project?")) return;
      try {
        await Api.deleteProject(btn.getAttribute("data-del-project"), false);
        await refreshSessions();
        renderProjects();
      } catch (err) {
        banner(err.message, true);
      }
    });
  });
  root.querySelectorAll("[data-attach-project]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const pid = btn.getAttribute("data-attach-project");
      const files = await window.clanker.pickFiles({});
      if (!files?.length) return;
      try {
        for (const f of files) {
          await Api.uploadProjectAttachment(pid, {
            data: f.data,
            mimeType: f.mimeType,
            filename: f.name,
            originalName: f.name,
          });
        }
        banner("Uploaded");
        await refreshSessions();
        renderProjects();
      } catch (err) {
        banner(err.message, true);
      }
    });
  });
  root.querySelectorAll("[data-del-att]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await Api.deleteProjectAttachment(btn.getAttribute("data-del-att"), btn.getAttribute("data-att"));
        await refreshSessions();
        renderProjects();
      } catch (err) {
        banner(err.message, true);
      }
    });
  });
}

async function editProject(existing) {
  const name = prompt("Project name", existing?.name || "");
  if (!name) return;
  const currentPaths = existing ? (existing.paths?.length ? existing.paths : [existing.path]) : [];
  const pathsRaw = prompt("Paths (one per line)", currentPaths.join("\n") || "");
  if (pathsRaw == null) return;
  const paths = pathsRaw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!paths.length) {
    banner("Need at least one path", true);
    return;
  }
  const color = prompt("Color (hex, optional)", existing?.color || "#73B8FF") || undefined;
  try {
    if (existing) {
      await Api.updateProject(existing.id, { name, paths, color });
    } else {
      await Api.createProject({ name, paths, color });
    }
    await refreshSessions();
    renderProjects();
  } catch (e) {
    banner(e.message, true);
  }
}

async function renderTasks() {
  const root = $("#view-tasks");
  if (!root) return;
  try {
    const res = await Api.listTasks();
    state.tasks = res.tasks || [];
  } catch (e) {
    root.innerHTML = `<div class="list-empty">${escapeHtml(e.message)}</div>`;
    return;
  }
  const q = state.tasksSearch.trim().toLowerCase();
  let rows = state.tasksShowDone ? state.tasks : state.tasks.filter((t) => t.status !== "done");
  if (q) {
    rows = rows.filter((t) => {
      const sid = t.sourceSessionId || t.sessionId;
      const sess = [...state.sessions, ...state.archived].find((s) => s.id === sid);
      return (t.text || "").toLowerCase().includes(q) || (sess?.title || "").toLowerCase().includes(q);
    });
  }
  root.innerHTML = `
    <div class="list-chrome">
      <div class="row-inline">
        <label class="check" style="margin:0"><input type="checkbox" id="t-done" ${state.tasksShowDone ? "checked" : ""}/> Showing done</label>
        <input id="task-search" class="search-input" placeholder="Search tasks &amp; sessions" value="${escapeAttr(state.tasksSearch)}" />
      </div>
    </div>
    <div class="stack-gap" style="max-width:820px">${
      rows.length
        ? rows
            .map((t) => {
              const sid = t.sourceSessionId || t.sessionId;
              const sess = [...state.sessions, ...state.archived].find((s) => s.id === sid);
              return `<button type="button" class="session-card task-card" data-open-task="${escapeAttr(sid)}" data-jump-msg="${escapeAttr(t.sourceMessageId || "")}">
                <h3>${t.status === "done" ? "☑ " : "☐ "}${escapeHtml(t.text)}</h3>
                <div class="meta"><span>${escapeHtml(sess?.title || sid)}</span><span class="${statusClass(t.status)}">${escapeHtml(t.status)}</span></div>
              </button>`;
            })
            .join("")
        : `<div class="list-empty">No tasks.</div>`
    }</div>`;
  $("#t-done")?.addEventListener("change", (e) => {
    state.tasksShowDone = e.target.checked;
    renderTasks();
  });
  $("#task-search")?.addEventListener("input", (e) => {
    state.tasksSearch = e.target.value;
    renderTasks();
  });
  root.querySelectorAll("[data-open-task]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setNav("sessions");
      openSession(btn.getAttribute("data-open-task"), btn.getAttribute("data-jump-msg") || undefined);
    });
  });
}

// ——— Bots (hunter) ———

const BOT_INTERVALS = [
  { value: "15m", label: "every 15 min" },
  { value: "30m", label: "every 30 min" },
  { value: "1h", label: "every hour" },
  { value: "6h", label: "every 6 hours" },
  { value: "12h", label: "every 12 hours" },
  { value: "1d", label: "daily" },
];

function relativeTimeLabel(iso) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const diff = Date.now() - t;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function intervalLabel(v) {
  return BOT_INTERVALS.find((i) => i.value === v)?.label || v || "manual";
}

function botProfileOptions() {
  return (state.profiles || []).filter((p) => p.backend === "bot");
}

function projectOptions() {
  return (state.projects || []);
}

async function loadBots({ preserveSelection = true } = {}) {
  state.botsLoading = true;
  try {
    const res = await Api.listBots();
    state.bots = res.bots || [];
    if (!preserveSelection || !state.bots.some((b) => b.id === state.selectedBotId)) {
      state.selectedBotId = state.bots[0]?.id || null;
    }
    if (state.selectedBotId) {
      await loadBotOutbox(state.selectedBotId);
    }
  } catch (e) {
    banner(e.message, true);
    state.bots = [];
  } finally {
    state.botsLoading = false;
  }
}

async function loadBotOutbox(botId) {
  try {
    const res = await Api.getBotOutbox(botId);
    state.botOutbox[botId] = res.items || [];
  } catch (e) {
    state.botOutbox[botId] = [];
  }
}

function renderTerminal() {
  const root = $("#view-terminal");
  if (!root) return;
  const { hostURL, token } = Api.getConnection();
  if (!hostURL || !token) {
    root.innerHTML = `<p class="hint">Connect a host in Desktop settings first.</p>`;
    return;
  }
  const src = `${String(hostURL).replace(/\/$/, "")}/app/terminal.html#token=${encodeURIComponent(token)}&autostart=1`;
  if (root.querySelector("iframe")?.getAttribute("src") === src) return;
  root.innerHTML = `<iframe class="term-frame" src="${escapeAttr(src)}" title="Host terminal"></iframe>`;
}

async function renderBots() {
  const root = $("#view-bots");
  if (!root) return;
  if (!state.bots.length && !state.botsLoading) {
    await loadBots({ preserveSelection: false });
  }

  const bots = state.bots || [];
  const bot = bots.find((b) => b.id === state.selectedBotId) || null;
  const outbox = bot ? state.botOutbox[bot.id] || [] : [];

  root.innerHTML = `
    <div class="bots-grid">
      <div class="bots-list panel list-panel">
        <div class="list-chrome">
          <div class="row-inline">
            <strong style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Bots · ${bots.length}</strong>
            <button type="button" class="primary" id="btn-new-bot">+ New bot</button>
          </div>
        </div>
        <div class="list-scroll">
          ${
            bots.length
              ? bots
                  .map((b) => {
                    const sel = b.id === state.selectedBotId ? "selected" : "";
                    const stateLabel = b.enabled ? "on" : "paused";
                    const stateCls = b.enabled ? "ok" : "muted";
                    return `<button type="button" class="session-card ${sel}" data-bot="${escapeAttr(b.id)}">
                      <h3>${escapeHtml(b.name || "Untitled bot")}</h3>
                      <div class="meta">
                        <span class="pill ${stateCls}">${stateLabel}</span>
                        <span>${escapeHtml(intervalLabel(b.interval))}</span>
                        <span>last run ${escapeHtml(relativeTimeLabel(b.lastRunAt))}</span>
                      </div>
                      <div class="preview">${escapeHtml((b.job || "").slice(0, 140))}</div>
                    </button>`;
                  })
                  .join("")
              : `<div class="list-empty">No bots yet.<br/>Create a profile with backend=bot in <strong>Profiles</strong>, then <strong>+ New bot</strong>.</div>`
          }
        </div>
      </div>

      <div class="panel detail-panel">
        ${bot ? renderBotDetail(bot, outbox) : `<p class="muted-center">Select a bot</p>`}
      </div>
    </div>

    ${state.newBotOpen ? renderNewBotForm() : ""}
  `;

  root.querySelectorAll("[data-bot]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.selectedBotId = btn.getAttribute("data-bot");
      await loadBotOutbox(state.selectedBotId);
      renderBots();
    });
  });

  $("#btn-new-bot")?.addEventListener("click", () => {
    state.newBotOpen = true;
    state.newBotDraft = {
      name: "",
      job: "",
      profileId: botProfileOptions()[0]?.id || "",
      projectId: projectOptions()[0]?.id || "",
      interval: "6h",
      enabled: false,
    };
    renderBots();
  });

  if (bot) wireBotDetail(bot);
  if (state.newBotOpen) wireNewBotForm();
}

function renderBotDetail(bot, outbox) {
  const draftJob = state.botDraftJob[bot.id] ?? bot.job ?? "";
  const runNote = state.botRunNote[bot.id] ?? "";
  const dirty = draftJob !== (bot.job || "");
  return `
    <div class="detail-head">
      <div class="detail-head-main">
        <h3>${escapeHtml(bot.name)}</h3>
        <div class="meta">
          <span>${escapeHtml(bot.enabled ? "Scheduled" : "Paused")}</span>
          <span>${escapeHtml(intervalLabel(bot.interval))}</span>
          <span>last run ${escapeHtml(relativeTimeLabel(bot.lastRunAt))}</span>
        </div>
      </div>
      <div class="row-actions">
        <label class="check" style="margin:0"><input type="checkbox" id="bot-enabled" ${bot.enabled ? "checked" : ""}/> Enable schedule</label>
        <select id="bot-interval">
          ${BOT_INTERVALS.map((i) => `<option value="${escapeAttr(i.value)}" ${i.value === bot.interval ? "selected" : ""}>${escapeHtml(i.label)}</option>`).join("")}
          ${BOT_INTERVALS.some((i) => i.value === bot.interval) ? "" : `<option selected value="${escapeAttr(bot.interval || "")}">${escapeHtml(bot.interval || "custom")}</option>`}
        </select>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <label class="field">Standing job</label>
      <textarea id="bot-job" placeholder="What should this bot do each fire?">${escapeHtml(draftJob)}</textarea>
      <div class="inline-actions">
        <button type="button" class="primary" id="bot-save-job" ${dirty ? "" : "disabled"}>Save job</button>
        ${dirty ? `<button type="button" class="ghost" id="bot-revert-job">Revert</button>` : ""}
      </div>
    </div>

    <div class="card">
      <label class="field">One-shot note (optional)</label>
      <input id="bot-run-note" placeholder="Only for this run — merged with the standing job." value="${escapeAttr(runNote)}" />
      <div class="inline-actions">
        <button type="button" class="primary" id="bot-run-now">Run now</button>
        ${bot.lastSessionId ? `<button type="button" class="secondary" id="bot-open-last">Open last session</button>` : ""}
      </div>
    </div>

    <div class="card">
      <div class="row-inline">
        <strong style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Outbox · ${outbox.length}</strong>
        <button type="button" class="ghost" id="bot-outbox-refresh">Refresh</button>
      </div>
      ${
        outbox.length
          ? `<div class="stack-gap" style="margin-top:8px">${outbox
              .map(
                (o) => `<details class="diff-file">
                  <summary>${escapeHtml(o.filename)} <span class="diff-stat">${escapeHtml(relativeTimeLabel(o.updatedAt))} · ${o.bytes}B</span></summary>
                  <pre class="diff-body">${escapeHtml(o.content || "(no preview)")}</pre>
                </details>`,
              )
              .join("")}</div>`
          : `<p class="hint">No outbox drafts yet.</p>`
      }
    </div>
  `;
}

function wireBotDetail(bot) {
  $("#bot-enabled")?.addEventListener("change", async (e) => {
    try {
      await Api.updateBot(bot.id, { enabled: e.target.checked });
      await loadBots();
      renderBots();
    } catch (err) {
      banner(err.message, true);
    }
  });
  $("#bot-interval")?.addEventListener("change", async (e) => {
    try {
      await Api.updateBot(bot.id, { interval: e.target.value });
      await loadBots();
      renderBots();
    } catch (err) {
      banner(err.message, true);
    }
  });
  $("#bot-job")?.addEventListener("input", (e) => {
    state.botDraftJob[bot.id] = e.target.value;
    // Cheap re-render just to toggle Save button; costs a full render. Fine for now.
    renderBots();
  });
  $("#bot-save-job")?.addEventListener("click", async () => {
    const nextJob = state.botDraftJob[bot.id] ?? bot.job;
    try {
      await Api.updateBot(bot.id, { job: nextJob });
      delete state.botDraftJob[bot.id];
      await loadBots();
      banner("Job saved");
      renderBots();
    } catch (err) {
      banner(err.message, true);
    }
  });
  $("#bot-revert-job")?.addEventListener("click", () => {
    delete state.botDraftJob[bot.id];
    renderBots();
  });
  $("#bot-run-note")?.addEventListener("input", (e) => {
    state.botRunNote[bot.id] = e.target.value;
  });
  $("#bot-run-now")?.addEventListener("click", async () => {
    const note = state.botRunNote[bot.id] || "";
    try {
      const res = await Api.runBot(bot.id, note ? { note } : {});
      delete state.botRunNote[bot.id];
      banner("Bot fired");
      await loadBots();
      renderBots();
      if (res?.session?.id) {
        setNav("sessions");
        openSession(res.session.id);
      }
    } catch (err) {
      banner(err.message, true);
    }
  });
  $("#bot-open-last")?.addEventListener("click", () => {
    if (bot.lastSessionId) {
      setNav("sessions");
      openSession(bot.lastSessionId);
    }
  });
  $("#bot-outbox-refresh")?.addEventListener("click", async () => {
    await loadBotOutbox(bot.id);
    renderBots();
  });
}

function renderNewBotForm() {
  const d = state.newBotDraft;
  const botProfiles = botProfileOptions();
  const projects = projectOptions();
  const canSave =
    !state.newBotSaving &&
    d.name.trim() &&
    d.job.trim() &&
    d.profileId &&
    d.projectId;
  return `
    <div class="modal-backdrop" id="newbot-backdrop">
      <div class="modal">
        <div class="modal-head">
          <h3>New bot</h3>
          <button type="button" class="ghost" id="newbot-close">✕</button>
        </div>
        <div class="modal-body">
          ${
            !botProfiles.length
              ? `<p class="hint" style="color:var(--warn)">No bot-backend profiles found. Open <strong>Profiles</strong> and create one with backend=bot first.</p>`
              : ""
          }
          <label class="field">Name</label>
          <input id="nb-name" placeholder="Lead hunter" value="${escapeAttr(d.name)}" />
          <label class="field">Standing job</label>
          <textarea id="nb-job" placeholder="What should this bot do each fire? Drafts go to .bot-outbox/ — nothing is sent until you approve.">${escapeHtml(d.job)}</textarea>
          <label class="field">Profile (bot backend)</label>
          <select id="nb-profile" ${botProfiles.length ? "" : "disabled"}>
            ${botProfiles
              .map(
                (p) =>
                  `<option value="${escapeAttr(p.id)}" ${p.id === d.profileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`,
              )
              .join("")}
          </select>
          <label class="field">Working directory (project)</label>
          <select id="nb-project">
            ${projects
              .map(
                (p) =>
                  `<option value="${escapeAttr(p.id)}" ${p.id === d.projectId ? "selected" : ""}>${escapeHtml(p.name)} — ${escapeHtml(p.path || (p.paths || [])[0] || "")}</option>`,
              )
              .join("")}
          </select>
          <label class="field">Schedule</label>
          <select id="nb-interval">
            ${BOT_INTERVALS.map((i) => `<option value="${escapeAttr(i.value)}" ${i.value === d.interval ? "selected" : ""}>${escapeHtml(i.label)}</option>`).join("")}
          </select>
          <label class="check"><input type="checkbox" id="nb-enabled" ${d.enabled ? "checked" : ""}/> Enable schedule</label>
        </div>
        <div class="modal-foot">
          <button type="button" class="ghost" id="newbot-cancel">Cancel</button>
          <button type="button" class="primary" id="newbot-save" ${canSave ? "" : "disabled"}>${state.newBotSaving ? "Saving…" : "Create bot"}</button>
        </div>
      </div>
    </div>
  `;
}

function wireNewBotForm() {
  const close = () => {
    state.newBotOpen = false;
    renderBots();
  };
  $("#newbot-close")?.addEventListener("click", close);
  $("#newbot-cancel")?.addEventListener("click", close);
  $("#newbot-backdrop")?.addEventListener("mousedown", (e) => {
    if (e.target.id === "newbot-backdrop") close();
  });
  $("#nb-name")?.addEventListener("input", (e) => { state.newBotDraft.name = e.target.value; });
  $("#nb-job")?.addEventListener("input", (e) => { state.newBotDraft.job = e.target.value; });
  $("#nb-profile")?.addEventListener("change", (e) => { state.newBotDraft.profileId = e.target.value; });
  $("#nb-project")?.addEventListener("change", (e) => { state.newBotDraft.projectId = e.target.value; });
  $("#nb-interval")?.addEventListener("change", (e) => { state.newBotDraft.interval = e.target.value; });
  $("#nb-enabled")?.addEventListener("change", (e) => { state.newBotDraft.enabled = e.target.checked; });
  $("#newbot-save")?.addEventListener("click", async () => {
    const d = state.newBotDraft;
    state.newBotSaving = true;
    try {
      const res = await Api.createBot({
        name: d.name.trim(),
        job: d.job.trim(),
        profileId: d.profileId,
        projectId: d.projectId,
        interval: d.interval,
        enabled: d.enabled,
      });
      state.newBotOpen = false;
      state.selectedBotId = res.bot?.id || null;
      await loadBots({ preserveSelection: true });
      banner("Bot created");
      renderBots();
    } catch (err) {
      banner(err.message, true);
    } finally {
      state.newBotSaving = false;
    }
  });
}

// ——— Host control panel ———

async function loadHostConfigPanel() {
  const res = await window.clanker.getHostConfig();
  state.hostConfig = res.config;
  state.hostConfigPath = res.path;
  return res;
}

function renderHost() {
  const root = $("#view-host");
  const hs = state.hostStatus;
  const cfg = state.hostConfig;
  const logs = (hs?.logs || []).join("\n");

  const install = hs?.install || {};
  const service = hs?.service || {};
  root.innerHTML = `
    <div class="host-grid two">
      <div class="stack-gap">
        <div class="card">
          <h3>Install gateway (out of git tree)</h3>
          <p class="kv">Installed: <strong>${install.installed ? escapeHtml(install.installRoot) : "No"}</strong></p>
          <p class="kv">User service: <strong>${
            service.active ? `active · ${escapeHtml(service.name || "")}` : service.loaded ? "unit present" : "not loaded"
          }</strong></p>
          <p class="hint">Same idea as the Mac app: copy a built host into a stable folder, enable systemd/launchd, keep config in <code>~/.grok-dispatch</code>.</p>
          <div class="inline-actions">
            <button type="button" class="primary" id="h-install">Install / update host</button>
            <button type="button" class="secondary" id="h-svc-load">Load service</button>
            <button type="button" class="secondary" id="h-svc-unload">Unload service</button>
            <button type="button" class="ghost" id="h-uninstall">Uninstall files…</button>
          </div>
          <div class="log-box" id="h-install-logs" style="margin-top:10px">${escapeHtml(state._installLogs || "(install log)")}</div>
        </div>
        <div class="card">
          <h3>Gateway process</h3>
          <p class="kv">Mode: <strong>${escapeHtml(hs?.mode || "—")}</strong></p>
          <p class="kv">Package: <strong>${escapeHtml(hs?.hostRoot || "—")}</strong></p>
          <p class="kv">API: <strong>${hs?.probe?.ok ? "reachable" : escapeHtml(hs?.probe?.error || "down")}</strong></p>
          <p class="kv">Process: <strong>${hs?.running ? `running (pid ${hs.pid})` : "stopped"}</strong>
            ${hs?.startedByUs ? " · owned by desktop" : hs?.probe?.ok ? " · external/service" : ""}</p>
          <div class="inline-actions">
            <button type="button" class="primary" id="h-start">Start</button>
            <button type="button" class="secondary" id="h-stop">Stop</button>
            <button type="button" class="secondary" id="h-restart">Restart</button>
            <button type="button" class="ghost" id="h-force-stop">Force stop</button>
          </div>
          <p class="hint" style="margin-top:10px">Prefer <strong>Install / update host</strong> + user service for production. Start is for foreground/dev ownership.</p>
        </div>
        <div class="card">
          <h3>Logs</h3>
          <div class="log-box" id="h-logs">${escapeHtml(logs) || "(no logs yet)"}</div>
        </div>
      </div>
      <div class="stack-gap">
        <div class="card">
          <h3>Host settings</h3>
          <p class="hint">File: <code>${escapeHtml(state.hostConfigPath || "")}</code>
            <button type="button" class="ghost" id="h-reveal" style="margin-left:6px">Reveal</button></p>
          ${
            cfg
              ? `
          <label class="field">Bind host</label>
          <input id="hc-bindHost" value="${escapeAttr(cfg.bindHost)}" />
          <label class="field">Bind port</label>
          <input id="hc-bindPort" type="number" value="${escapeAttr(cfg.bindPort)}" />
          <label class="field">Grok binary</label>
          <input id="hc-grok" value="${escapeAttr(cfg.grokBinary)}" />
          <label class="field">Host token</label>
          <input id="hc-token" value="${escapeAttr(cfg.hostToken)}" spellcheck="false" />
          <div class="inline-actions">
            <button type="button" class="secondary" id="hc-regen">Regenerate token</button>
            <button type="button" class="secondary" id="hc-copy">Copy token</button>
          </div>
          <label class="check"><input type="checkbox" id="hc-allow" ${cfg.allowCustomPaths ? "checked" : ""}/> Allow custom paths</label>
          <label class="check"><input type="checkbox" id="hc-notify" ${cfg.notifyDesktop ? "checked" : ""}/> Host OS notifications</label>
          <label class="field">Auto-approve kinds (comma-separated)</label>
          <input id="hc-auto" value="${escapeAttr((cfg.autoApproveKinds || []).join(", "))}" />
          `
              : `<p class="hint">No host config yet.</p><button type="button" class="primary" id="hc-ensure">Create config</button>`
          }
        </div>
        <div class="card">
          <h3>Projects</h3>
          <div id="hc-projects"></div>
          <div class="inline-actions">
            <button type="button" class="secondary" id="hc-add-project">Add project</button>
          </div>
        </div>
        <div class="card">
          <h3>Agent profiles</h3>
          <p class="hint">Secrets are write-only: leave API key blank to keep the existing value.</p>
          <div id="hc-profiles"></div>
        </div>
        ${
          cfg
            ? `<div class="inline-actions">
          <button type="button" class="primary" id="hc-save">Save host config</button>
          <button type="button" class="secondary" id="hc-save-restart">Save &amp; restart host</button>
        </div>`
            : ""
        }
      </div>
    </div>`;

  const projectsRoot = $("#hc-projects");
  if (projectsRoot && cfg) {
    const projects = [...(cfg.projects || [])];
    const drawProjects = () => {
      projectsRoot.innerHTML =
        projects
          .map(
            (p, i) => `
        <div class="project-row" data-i="${i}">
          <input data-k="id" placeholder="id" value="${escapeAttr(p.id)}" />
          <input data-k="name" placeholder="name" value="${escapeAttr(p.name)}" />
          <input data-k="paths" placeholder="/path/one, /path/two" value="${escapeAttr((p.paths && p.paths.length ? p.paths : [p.path]).filter(Boolean).join(", "))}" />
          <button type="button" class="ghost" data-browse="${i}">…</button>
        </div>`,
          )
          .join("") || `<p class="hint">No projects — add one.</p>`;
      projectsRoot.querySelectorAll(".project-row").forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelectorAll("input").forEach((inp) => {
          inp.addEventListener("change", () => {
            const k = inp.dataset.k;
            if (k === "paths") {
              const paths = inp.value.split(",").map((s) => s.trim()).filter(Boolean);
              projects[i].paths = paths;
              projects[i].path = paths[0] || "";
            } else {
              projects[i][k] = inp.value;
            }
          });
        });
      });
      projectsRoot.querySelectorAll("[data-browse]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const i = Number(btn.getAttribute("data-browse"));
          const dir = await window.clanker.pickDirectory();
          if (dir) {
            const paths = [...(projects[i].paths || (projects[i].path ? [projects[i].path] : []))];
            if (!paths.includes(dir)) paths.push(dir);
            projects[i].paths = paths;
            projects[i].path = paths[0];
            drawProjects();
          }
        });
      });
    };
    drawProjects();
    $("#hc-add-project")?.addEventListener("click", () => {
      projects.push({ id: `project-${projects.length + 1}`, name: "Project", path: "", paths: [] });
      drawProjects();
    });
    state._editProjects = projects;
  }

  const profilesRoot = $("#hc-profiles");
  if (profilesRoot && cfg) {
    const profiles = (cfg.profiles || []).map((p) => ({ ...p, _apiKey: "" }));
    profilesRoot.innerHTML = profiles
      .map(
        (p, i) => `
      <div class="card" style="background:#12121a;margin-bottom:8px" data-pi="${i}">
        <div class="meta"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${escapeAttr(p.color)}"></span>
          <strong>${escapeHtml(p.name)}</strong> · ${escapeHtml(p.backend)}
          ${p.hasCredentials ? "· credentials set" : "· no credentials"}</div>
        <label class="field">Display name</label>
        <input data-pk="name" value="${escapeAttr(p.name)}" />
        <label class="field">Color</label>
        <input data-pk="color" value="${escapeAttr(p.color || "")}" />
        <label class="field">Model (optional)</label>
        <input data-pk="model" value="${escapeAttr(p.model || "")}" />
        <label class="field">Claude config dir (optional)</label>
        <input data-pk="claudeConfigDir" value="${escapeAttr(p.claudeConfigDir || "")}" />
        <label class="field">ANTHROPIC_API_KEY (leave blank to keep)</label>
        <input data-pk="_apiKey" type="password" placeholder="${p.hasCredentials ? "••••••••" : "sk-…"}" autocomplete="off" />
      </div>`,
      )
      .join("") || `<p class="hint">No profiles in config.</p>`;
    profilesRoot.querySelectorAll("[data-pi]").forEach((card) => {
      const i = Number(card.dataset.pi);
      card.querySelectorAll("input").forEach((inp) => {
        inp.addEventListener("change", () => {
          profiles[i][inp.dataset.pk] = inp.value;
        });
      });
    });
    state._editProfiles = profiles;
  }

  const collectPatch = () => {
    if (!cfg) return null;
    const profiles = (state._editProfiles || []).map((p) => {
      const out = {
        id: p.id,
        name: p.name,
        backend: p.backend,
        color: p.color,
        model: p.model,
        claudeConfigDir: p.claudeConfigDir,
      };
      if (p._apiKey) out.env = { ANTHROPIC_API_KEY: p._apiKey };
      return out;
    });
    return {
      bindHost: $("#hc-bindHost")?.value.trim(),
      bindPort: Number($("#hc-bindPort")?.value || 8787),
      grokBinary: $("#hc-grok")?.value.trim(),
      hostToken: $("#hc-token")?.value.trim(),
      allowCustomPaths: $("#hc-allow")?.checked,
      notifyDesktop: $("#hc-notify")?.checked,
      autoApproveKinds: ($("#hc-auto")?.value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      projects: (state._editProjects || cfg.projects || []).map((pr) => {
        const paths = Array.isArray(pr.paths) && pr.paths.length
          ? pr.paths
          : String(pr.path || "").split(",").map((s) => s.trim()).filter(Boolean);
        return { ...pr, paths, path: paths[0] || pr.path || "" };
      }),
      profiles,
    };
  };

  $("#h-install")?.addEventListener("click", async () => {
    banner("Installing host…");
    state._installLogs = "Installing…\n";
    const box = $("#h-install-logs");
    if (box) box.textContent = state._installLogs;
    const r = await window.clanker.hostInstall({ loadService: true });
    state._installLogs = (r.logs || []).join("") || r.error || "";
    if (box) box.textContent = state._installLogs || "(done)";
    if (!r.ok) banner(r.error || "Install failed", true);
    else {
      banner("Host installed");
      await syncConnection();
      await refreshHostStatus();
      await loadHostConfigPanel();
      await refreshSessions();
      renderHost();
    }
  });
  $("#h-svc-load")?.addEventListener("click", async () => {
    const r = await window.clanker.hostServiceLoad();
    if (!r.ok) banner(r.error || "Load failed", true);
    else banner("User service loaded");
    await refreshHostStatus();
    renderHost();
  });
  $("#h-svc-unload")?.addEventListener("click", async () => {
    const r = await window.clanker.hostServiceUnload();
    if (!r.ok) banner(r.error || "Unload failed", true);
    else banner("User service unloaded");
    await refreshHostStatus();
    renderHost();
  });
  $("#h-uninstall")?.addEventListener("click", async () => {
    if (!confirm("Remove installed host package files and unload the user service?")) return;
    const r = await window.clanker.hostUninstall({ removeFiles: true });
    if (!r.ok) banner(r.error || "Uninstall failed", true);
    else banner("Host package removed");
    await refreshHostStatus();
    renderHost();
  });

  $("#h-start")?.addEventListener("click", async () => {
    const r = await window.clanker.hostStart();
    if (!r.ok) banner(r.error || "Start failed", true);
    else banner("Host started");
    await syncConnection();
    await refreshHostStatus();
    await refreshSessions();
  });
  $("#h-stop")?.addEventListener("click", async () => {
    const r = await window.clanker.hostStop();
    if (!r.ok) banner(r.error || "Stop failed", true);
    else banner("Host stopped");
    await refreshHostStatus();
  });
  $("#h-force-stop")?.addEventListener("click", async () => {
    const r = await window.clanker.hostStop({ force: true });
    if (!r.ok) banner(r.error || "Force stop failed", true);
    else banner("Host force-stopped");
    await refreshHostStatus();
  });
  $("#h-restart")?.addEventListener("click", async () => {
    const r = await window.clanker.hostRestart();
    if (!r.ok) banner(r.error || "Restart failed", true);
    else banner("Host restarted");
    await syncConnection();
    await refreshHostStatus();
    await refreshSessions();
  });
  $("#h-reveal")?.addEventListener("click", () => window.clanker.showPath(state.hostConfigPath));
  $("#hc-ensure")?.addEventListener("click", async () => {
    await window.clanker.ensureHostConfig();
    await loadHostConfigPanel();
    await syncConnection();
    renderHost();
  });
  $("#hc-regen")?.addEventListener("click", async () => {
    await window.clanker.regenerateToken();
    banner("Token regenerated — clients must update");
    await loadHostConfigPanel();
    await syncConnection();
    renderHost();
  });
  $("#hc-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#hc-token")?.value || "");
      banner("Token copied");
    } catch {
      banner("Could not copy", true);
    }
  });
  $("#hc-save")?.addEventListener("click", async () => {
    const patch = collectPatch();
    if (!patch) return;
    try {
      await window.clanker.saveHostConfig(patch);
      banner("Host config saved (restart host to apply bind/port)");
      await loadHostConfigPanel();
      await syncConnection();
      renderHost();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#hc-save-restart")?.addEventListener("click", async () => {
    const patch = collectPatch();
    if (!patch) return;
    try {
      await window.clanker.saveHostConfig(patch);
      const r = await window.clanker.hostRestart();
      if (!r.ok) banner(r.error || "Saved but restart failed", true);
      else banner("Saved & restarted");
      await loadHostConfigPanel();
      await syncConnection();
      await refreshHostStatus();
      await refreshSessions();
      renderHost();
    } catch (e) {
      banner(e.message, true);
    }
  });

  const logEl = $("#h-logs");
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

// ——— Profiles manager (loopback only) ———

const PROFILE_BACKEND_LABEL = {
  grok: "Grok (xAI ACP)",
  claude: "Claude Code",
  antigravity: "Gemini (Antigravity)",
  bot: "Bot (autonomous)",
};
const PROFILE_BACKEND_OPTIONS = ["grok", "claude", "antigravity", "bot"];
const PROFILE_DEFAULT_COLOR = {
  grok: "#73B8FF",
  claude: "#F97316",
  antigravity: "#34A853",
  bot: "#E879F9",
};

function renderProfilesAdmin() {
  const root = $("#view-profiles");
  if (!root) return;
  if (!Api.getConnection().token) {
    root.innerHTML = `<div class="empty-detail"><p class="muted-center">Connect to a host in Desktop settings to load profiles.</p></div>`;
    return;
  }

  const active = state.desktopConfig?.hosts?.find(
    (h) => h.id === state.desktopConfig?.activeHostId,
  );
  const activeHostURL = active?.hostURL || "";

  if (!state.admin) {
    root.innerHTML = `
      <div class="settings-grid">
        <div class="card">
          <h3>Profiles manager</h3>
          <p class="hint">Profile creation and secret editing are restricted to the machine running the host — API keys never traverse the network.
          You're connected to <code>${escapeHtml(activeHostURL || "?")}</code>, which the host sees as a non-loopback client, so this pane is read-only here.</p>
          <p class="hint">Options: switch the active host to a loopback URL (<code>http://127.0.0.1:8787</code>) in Desktop settings, or open the built-in browser control plane at
          <code>${escapeHtml(activeHostURL || "http://host")}/app/</code> on the host machine itself.</p>
        </div>
        <div class="card">
          <h3>Configured profiles (read-only)</h3>
          <div class="profile-list">${(state.profiles || [])
            .map(
              (p) => `
              <div class="profile-row">
                <span class="profile-dot" style="background:${escapeAttr(p.color || "#73B8FF")}"></span>
                <div class="profile-meta">
                  <div><strong>${escapeHtml(p.name)}</strong>
                    <span class="pill muted">${escapeHtml(PROFILE_BACKEND_LABEL[p.backend] || p.backend)}</span>
                    ${p.hasCredentials ? '<span class="pill ok">ready</span>' : '<span class="pill warn">no creds</span>'}
                  </div>
                  <div class="meta">${escapeHtml(p.id)}${p.model ? ` · model ${escapeHtml(p.model)}` : ""}</div>
                </div>
              </div>`,
            )
            .join("")}</div>
        </div>
      </div>`;
    return;
  }

  const rows = (state.adminProfiles || [])
    .map((p) => {
      const publ = (state.profiles || []).find((x) => x.id === p.id) || {};
      const dir =
        p.backend === "claude" ? p.claudeConfigDir : p.backend === "antigravity" ? p.antigravityConfigDir : "";
      const envCount = p.env ? Object.keys(p.env).filter((k) => k.trim()).length : 0;
      const canLogin = p.backend === "claude";
      return `
        <div class="profile-row">
          <span class="profile-dot" style="background:${escapeAttr(p.color || "#73B8FF")}"></span>
          <div class="profile-meta">
            <div>
              <strong>${escapeHtml(p.name)}</strong>
              <span class="pill muted">${escapeHtml(PROFILE_BACKEND_LABEL[p.backend] || p.backend)}</span>
              ${publ.hasCredentials ? '<span class="pill ok">ready</span>' : '<span class="pill warn">no creds</span>'}
            </div>
            <div class="meta">
              <span>${escapeHtml(p.id)}</span>
              ${p.model ? `<span>model ${escapeHtml(p.model)}</span>` : ""}
              ${dir ? `<span>dir ${escapeHtml(shortPath(dir))}</span>` : ""}
              ${envCount ? `<span>env keys ${envCount}</span>` : ""}
            </div>
          </div>
          <div class="inline-actions" style="margin-top:0">
            ${canLogin ? `<button type="button" class="secondary" data-login="${escapeAttr(p.id)}">Login</button>` : ""}
            <button type="button" class="secondary" data-edit="${escapeAttr(p.id)}">Edit</button>
            <button type="button" class="danger" data-delete="${escapeAttr(p.id)}">Delete</button>
          </div>
        </div>`;
    })
    .join("");

  root.innerHTML = `
    <div class="settings-grid">
      <div class="card">
        <div class="row-inline" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h3>Profiles</h3>
            <p class="hint">Local admin — creds and config paths are written straight to
            <code>~/.grok-dispatch/config.json</code>. Restart the host to spawn agents under a new profile.</p>
          </div>
          <div class="inline-actions">
            <button type="button" class="primary" id="btn-new-profile">Add profile</button>
          </div>
        </div>
        <div class="profile-list">${rows || '<p class="hint">No profiles yet.</p>'}</div>
      </div>
      <div id="profile-editor"></div>
    </div>`;

  root.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => openProfileEditor(btn.getAttribute("data-edit"))),
  );
  root.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => deleteProfileAdmin(btn.getAttribute("data-delete"))),
  );
  root.querySelectorAll("[data-login]").forEach((btn) =>
    btn.addEventListener("click", () => loginProfileAdmin(btn.getAttribute("data-login"))),
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
        color: PROFILE_DEFAULT_COLOR.grok,
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
    color: source.color || PROFILE_DEFAULT_COLOR[source.backend] || "#73B8FF",
    model: source.model || "",
    systemPrompt: source.systemPrompt || "",
    claudeConfigDir: source.claudeConfigDir || "",
    antigravityConfigDir: source.antigravityConfigDir || "",
    envText: envToText(source.env || {}),
  };
  state.profileEditor = { id: id || null, draft };

  const dir =
    draft.backend === "claude"
      ? { label: "Claude config dir (CLAUDE_CONFIG_DIR)", key: "claudeConfigDir", hint: "Set for a second Claude account so it uses its own OAuth store. Leave blank for the default ~/.claude." }
      : draft.backend === "antigravity"
        ? { label: "Antigravity config dir", key: "antigravityConfigDir", hint: "Reserved — the agy CLI still uses the global ~/.gemini keyring today, so a second Gemini profile shares creds until Google adds isolation." }
        : null;

  const envHint =
    draft.backend === "claude"
      ? "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN. Leave blank to use interactive Claude login."
      : draft.backend === "antigravity"
        ? "GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY. Or leave blank and run `agy` on the host."
        : draft.backend === "bot"
          ? "One of XAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY + OPENAI_BASE_URL."
          : "XAI_API_KEY. Blank uses the local `grok` CLI login under ~/.grok/auth.json.";

  const editor = $("#profile-editor");
  if (!editor) return;
  editor.innerHTML = `
    <div class="card">
      <h3>${isNew ? "New profile" : `Edit ${escapeHtml(source.name)}`}</h3>
      <label class="field">Name</label>
      <input id="pe-name" value="${escapeAttr(draft.name)}" placeholder="e.g. Work Claude" />
      ${isNew
        ? `<label class="field">Id (slug — leave blank to derive)</label>
           <input id="pe-id" value="${escapeAttr(draft.id)}" placeholder="auto" />`
        : ""}
      <label class="field">Backend</label>
      <select id="pe-backend">${PROFILE_BACKEND_OPTIONS.map(
        (b) => `<option value="${b}" ${b === draft.backend ? "selected" : ""}>${escapeHtml(PROFILE_BACKEND_LABEL[b])}</option>`,
      ).join("")}</select>
      <label class="field">Color</label>
      <input id="pe-color" value="${escapeAttr(draft.color)}" />
      <label class="field">Model (blank = CLI default)</label>
      <input id="pe-model" value="${escapeAttr(draft.model)}" placeholder="claude / grok-4 / gemini-3.5-flash-medium" />
      ${dir
        ? `<label class="field">${escapeHtml(dir.label)}</label>
           <input id="pe-configdir" value="${escapeAttr(draft[dir.key])}" placeholder="~/.claude-work" />
           <p class="hint">${escapeHtml(dir.hint)}</p>`
        : ""}
      <label class="field">Environment (KEY=VALUE per line — stays on this machine)</label>
      <textarea id="pe-env" rows="4" spellcheck="false" placeholder="ANTHROPIC_API_KEY=sk-...">${escapeHtml(draft.envText)}</textarea>
      <p class="hint">${escapeHtml(envHint)}</p>
      <label class="field">System prompt (Claude persona — appended)</label>
      <textarea id="pe-sysprompt" rows="3">${escapeHtml(draft.systemPrompt)}</textarea>
      <div class="inline-actions" style="justify-content:flex-end;margin-top:12px">
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
    const prevDefault = PROFILE_DEFAULT_COLOR[draft.backend];
    if (!next.color || next.color.toLowerCase() === (prevDefault || "").toLowerCase()) {
      next.color = PROFILE_DEFAULT_COLOR[next.backend] || next.color;
    }
    openProfileEditor(id, next);
  });
  $("#pe-cancel").addEventListener("click", () => {
    state.profileEditor = null;
    renderProfilesAdmin();
  });
  $("#pe-save").addEventListener("click", async () => {
    const d = readDraft();
    if (!d.name) {
      banner("Name is required", true);
      return;
    }
    const payload = {
      name: d.name,
      backend: d.backend,
      color: d.color || PROFILE_DEFAULT_COLOR[d.backend],
      model: d.model || null,
      systemPrompt: d.systemPrompt || null,
      claudeConfigDir: d.claudeConfigDir || null,
      antigravityConfigDir: d.antigravityConfigDir || null,
      env: envFromText(d.envText),
    };
    try {
      if (isNew) {
        if (d.id) payload.id = d.id;
        await Api.createProfile(payload);
        banner("Profile created — restart the host to spawn agents under it");
      } else {
        await Api.updateProfile(source.id, payload);
        banner("Profile saved");
      }
      state.profileEditor = null;
      await refreshSessions();
      renderProfilesAdmin();
    } catch (e) {
      banner(e.message, true);
    }
  });
}

async function deleteProfileAdmin(id) {
  if (!id) return;
  if (!confirm(`Delete profile "${id}"? Config file is updated immediately.`)) return;
  try {
    await Api.deleteProfile(id);
    banner("Profile deleted");
    if (state.profileEditor?.id === id) state.profileEditor = null;
    await refreshSessions();
    renderProfilesAdmin();
  } catch (e) {
    banner(e.message, true);
  }
}

async function loginProfileAdmin(id) {
  if (!id) return;
  try {
    const r = await Api.loginProfile(id);
    banner(r?.message || "Login started — check the host machine");
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

// ——— Desktop settings ———

function renderDesktopSettings() {
  const root = $("#view-settings");
  const d = state.desktopConfig || {};
  const hosts = Array.isArray(d.hosts) ? d.hosts : [];
  const activeId = d.activeHostId;
  const activeHost = hosts.find((h) => h.id === activeId) || hosts[0] || {};

  root.innerHTML = `
    <div class="settings-grid">
      <div class="card">
        <h3>Hosts</h3>
        <p class="hint">Add multiple hosts (LAN, Tailscale, work box). Switch the active host from the header chip.</p>
        <div id="hosts-list"></div>
        <div class="inline-actions">
          <button type="button" class="secondary" id="btn-add-host">Add host</button>
        </div>
      </div>

      <div class="card">
        <h3>Active host settings</h3>
        <label class="field">Mode</label>
        <div class="row-inline">
          <label class="check"><input type="radio" name="mode" value="managed" ${activeHost.mode !== "remote" ? "checked" : ""}/> Managed (local)</label>
          <label class="check"><input type="radio" name="mode" value="remote" ${activeHost.mode === "remote" ? "checked" : ""}/> Remote</label>
        </div>
        <label class="field">Host URL (remote mode)</label>
        <input id="ds-url" value="${escapeAttr(activeHost.hostURL || "http://127.0.0.1:8787")}" />
        <label class="field">Host token (remote; managed syncs from config file)</label>
        <input id="ds-token" value="${escapeAttr(activeHost.token || "")}" spellcheck="false" />
        <label class="field">Host package path (optional override)</label>
        <input id="ds-hostpath" value="${escapeAttr(d.hostPackagePath || "")}" placeholder="auto: bundled or ../host" />
        <div class="inline-actions">
          <button type="button" class="secondary" id="ds-browse-host">Browse…</button>
        </div>
        <label class="check"><input type="checkbox" id="ds-autostart" ${d.autoStartHost !== false ? "checked" : ""}/> Auto-start host when desktop launches (managed)</label>
        <label class="check"><input type="checkbox" id="ds-stopquit" ${d.stopHostOnQuit !== false ? "checked" : ""}/> Stop host on quit if we started it</label>
        <label class="check"><input type="checkbox" id="ds-notify" ${d.notifications !== false ? "checked" : ""}/> Desktop OS notifications</label>
        <label class="check"><input type="checkbox" id="ds-min" ${d.startMinimized ? "checked" : ""}/> Start minimized to tray</label>
        <div class="inline-actions">
          <button type="button" class="primary" id="ds-save">Save desktop settings</button>
        </div>
      </div>
      <p class="hint">Desktop prefs live in Electron userData. Host gateway config is <code>~/.grok-dispatch/config.json</code> (edit under Host).</p>
    </div>`;

  const hostsList = $("#hosts-list");
  if (hostsList) {
    if (!hosts.length) {
      hostsList.innerHTML = `<p class="hint">No hosts yet.</p>`;
    } else {
      hostsList.innerHTML = hosts
        .map(
          (h) => `
        <div class="host-row ${h.id === activeId ? "active" : ""}">
          <div>
            <div><strong>${escapeHtml(h.name || "host")}</strong> ${h.id === activeId ? '<span class="pill ok">active</span>' : ""}</div>
            <div class="meta"><span>${escapeHtml(h.hostURL)}</span><span>${escapeHtml(h.mode || "managed")}</span></div>
          </div>
          <div class="inline-actions" style="margin-top:0">
            ${h.id !== activeId ? `<button type="button" class="secondary" data-activate="${escapeAttr(h.id)}">Activate</button>` : ""}
            <button type="button" class="ghost" data-edit-host="${escapeAttr(h.id)}">Rename</button>
            ${hosts.length > 1 ? `<button type="button" class="danger" data-remove-host="${escapeAttr(h.id)}">Remove</button>` : ""}
          </div>
        </div>`,
        )
        .join("");
    }
    hostsList.querySelectorAll("[data-activate]").forEach((btn) =>
      btn.addEventListener("click", () => switchHost(btn.getAttribute("data-activate"))),
    );
    hostsList.querySelectorAll("[data-remove-host]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this host?")) return;
        await window.clanker.removeHost(btn.getAttribute("data-remove-host"));
        state.desktopConfig = await window.clanker.getDesktopConfig();
        renderActiveHostChip();
        renderDesktopSettings();
      }),
    );
    hostsList.querySelectorAll("[data-edit-host]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-edit-host");
        const h = hosts.find((x) => x.id === id);
        const name = prompt("Host name", h?.name || "");
        if (!name) return;
        await window.clanker.saveHost({ id, name });
        state.desktopConfig = await window.clanker.getDesktopConfig();
        renderActiveHostChip();
        renderDesktopSettings();
      }),
    );
  }

  $("#btn-add-host")?.addEventListener("click", async () => {
    const name = prompt("Host name (e.g. laptop, work-box)");
    if (!name) return;
    const hostURL = prompt("Host URL", "http://127.0.0.1:8787");
    if (!hostURL) return;
    const token = prompt("Host token (blank for managed local hosts)", "") || "";
    await window.clanker.saveHost({ name, hostURL, token, mode: token ? "remote" : "managed" });
    state.desktopConfig = await window.clanker.getDesktopConfig();
    renderActiveHostChip();
    renderDesktopSettings();
  });

  $("#ds-browse-host")?.addEventListener("click", async () => {
    const dir = await window.clanker.pickDirectory();
    if (dir) $("#ds-hostpath").value = dir;
  });
  $("#ds-save")?.addEventListener("click", async () => {
    const mode = $$("input[name=mode]").find((r) => r.checked)?.value || "managed";
    if (activeHost.id) {
      await window.clanker.saveHost({
        id: activeHost.id,
        mode,
        hostURL: $("#ds-url").value.trim(),
        token: $("#ds-token").value.trim(),
      });
    }
    state.desktopConfig = await window.clanker.saveDesktopConfig({
      hostPackagePath: $("#ds-hostpath").value.trim(),
      autoStartHost: $("#ds-autostart").checked,
      stopHostOnQuit: $("#ds-stopquit").checked,
      notifications: $("#ds-notify").checked,
      startMinimized: $("#ds-min").checked,
    });
    await syncConnection();
    await refreshHostStatus();
    await refreshSessions();
    renderActiveHostChip();
    banner("Desktop settings saved");
  });
}

// ——— Boot ———

function wireChrome() {
  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setNav(btn.dataset.nav));
  });
  $("#btn-viewer")?.addEventListener("click", () => {
    state.showViewer = !state.showViewer;
    syncViewerPane();
    if (state.showViewer) loadViewer(state.viewerPath);
  });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "n" && !e.shiftKey) {
      e.preventDefault();
      setNav("compose");
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      setNav("projects");
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      setNav("tasks");
    } else if (ctrl && e.altKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      state.showViewer = !state.showViewer;
      if (state.nav !== "sessions") setNav("sessions");
      syncViewerPane();
      if (state.showViewer) loadViewer(state.viewerPath);
    }
  });
  $("#btn-refresh")?.addEventListener("click", async () => {
    await syncConnection();
    await refreshHostStatus();
    await refreshSessions();
    banner("Refreshed");
  });
  $("#btn-host-start")?.addEventListener("click", async () => {
    const r = await window.clanker.hostStart();
    if (!r.ok) banner(r.error || "Start failed", true);
    else banner("Host started");
    await syncConnection();
    await refreshHostStatus();
    await refreshSessions();
  });
  $("#btn-host-stop")?.addEventListener("click", async () => {
    const r = await window.clanker.hostStop();
    if (!r.ok) banner(r.error || "Stop failed", true);
    else banner("Host stopped");
    await refreshHostStatus();
  });

  window.clanker.onWsStatus(({ status }) => setWsPill(status));
  window.clanker.onHostEvent(({ event }) => applyEvent(event));
  window.clanker.onHostLog(({ line }) => {
    if (state.nav === "host") {
      const box = $("#h-logs");
      if (box) {
        box.textContent = (box.textContent === "(no logs yet)" ? "" : box.textContent + "\n") + line;
        box.scrollTop = box.scrollHeight;
      }
    }
  });
  window.clanker.onHostProcess((snap) => {
    if (state.hostStatus) Object.assign(state.hostStatus, snap);
    else state.hostStatus = snap;
    renderHostMini();
  });
  window.clanker.onSessionFocus(({ sessionId }) => {
    setNav("sessions");
    if (sessionId) openSession(sessionId);
  });
  window.clanker.onDesktopConfig?.(async (cfg) => {
    state.desktopConfig = cfg;
    renderActiveHostChip();
  });
  window.clanker.onApprovalAction?.(async ({ sessionId, approvalId, action }) => {
    if (!sessionId || !approvalId) return;
    if (state.selectedId !== sessionId) await openSession(sessionId);
    try {
      state.detail =
        action === "approve"
          ? await Api.approve(sessionId, { approvalId, scope: "once" })
          : await Api.reject(sessionId, { approvalId });
      trackHighestSeq(state.detail);
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
}

async function boot() {
  wireChrome();
  await syncConnection();
  await refreshHostStatus();
  await loadHostConfigPanel();
  renderActiveHostChip();
  setNav("sessions");
  await refreshSessions();
  syncViewerPane();

  state.refreshTimer = setInterval(async () => {
    await refreshHostStatus();
    if (state.wsStatus !== "live") await refreshSessions();
  }, 8000);
  state.usageTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await Api.profiles({ usage: true, admin: true });
      if (res?.profiles) {
        state.profiles = res.profiles;
        state.admin = res.admin === true;
        state.adminProfiles = res.adminProfiles || [];
        renderProfiles();
        if (state.nav === "profiles") renderProfilesAdmin();
      }
    } catch {
      /* */
    }
  }, 60_000);
}

boot().catch((e) => {
  console.error(e);
  banner(e.message || String(e), true);
});
