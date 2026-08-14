"use strict";

const state = {
  nav: "sessions",
  filter: "recent",
  search: "",
  searchDebounce: null,
  sessions: [],
  archived: [],
  disk: [],
  claude: [],
  projects: [],
  profiles: [],
  profileId: null,
  detail: null,
  selectedId: null,
  tab: "transcript",
  diff: null,
  diffLoading: false,
  approvalDraftComment: "",
  wsStatus: "offline",
  hostStatus: null,
  desktopConfig: null,
  hostConfig: null,
  hostConfigPath: "",
  refreshTimer: null,
  lastSeqBySession: {},
  streamingText: "",
  streamingTimer: null,
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
    compose: "Compose",
    grok: "Grok disk",
    claude: "Claude disk",
    host: "Host",
    settings: "Desktop",
  };
  $("#view-title").textContent = titles[nav] || nav;
  $("#toolbar").classList.toggle("hidden", nav === "host" || nav === "settings");
  $(".toolbar-right").classList.toggle("hidden", nav !== "sessions");
  $("#profile-bar").classList.toggle("hidden", nav !== "sessions" && nav !== "compose");

  $("#view-sessions").classList.toggle("active", nav === "sessions");
  $("#view-sessions").classList.toggle("hidden", nav !== "sessions");
  $("#view-compose").classList.toggle("hidden", nav !== "compose");
  $("#view-disk").classList.toggle("hidden", nav !== "grok" && nav !== "claude");
  $("#view-host").classList.toggle("hidden", nav !== "host");
  $("#view-settings").classList.toggle("hidden", nav !== "settings");

  if (nav === "sessions") {
    renderSessionList();
    if (state.detail) renderDetail();
  } else if (nav === "compose") renderCompose();
  else if (nav === "grok" || nav === "claude") renderDisk(nav);
  else if (nav === "host") renderHost();
  else if (nav === "settings") renderDesktopSettings();
}

// ——— Profiles ———

function renderProfiles() {
  const bar = $("#profile-bar");
  if (!state.profiles.length) {
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML = state.profiles
    .map((p) => {
      const active = p.id === state.profileId;
      return `<button type="button" class="profile-chip ${active ? "active" : ""}" data-profile="${escapeAttr(p.id)}" style="--chip:${escapeAttr(p.color || "#73b8ff")}">
        <span class="dot" style="background:${escapeAttr(p.color || "#73b8ff")}"></span>
        ${escapeHtml(p.name)}
      </button>`;
    })
    .join("");
  bar.querySelectorAll("[data-profile]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.profileId = btn.getAttribute("data-profile");
      renderProfiles();
      if (state.nav === "sessions") renderSessionList();
      if (state.nav === "compose") renderCompose();
    });
  });
}

// ——— Sessions (command center) ———

function sessionPoolForFilter() {
  if (state.filter === "archived") return state.archived;
  const active = new Set(["running", "queued", "awaiting_approval", "awaiting_question"]);
  if (state.filter === "active") return state.sessions.filter((s) => active.has(s.status));
  return state.sessions;
}

function filteredSessions() {
  let rows = sessionPoolForFilter();
  if (state.profileId) {
    rows = rows.filter((s) => {
      if (s.profileId) return s.profileId === state.profileId;
      const p = state.profiles.find((x) => x.id === state.profileId);
      if (!p) return true;
      return (s.backend || "grok") === p.backend;
    });
  }
  const q = state.search.trim().toLowerCase();
  if (q) {
    rows = rows.filter((s) => {
      const hay = [s.title, s.transcriptPreview, s.prompt, s.cwd, s.profileName, s.backend]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  return rows;
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
      <input id="session-search" class="search-input" placeholder="Search sessions…" value="${searchVal}" />
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
        <button type="button" class="session-card ${selected}" data-open="${escapeAttr(s.id)}">
          <h3>${attention}${escapeHtml(s.title || "Session")}</h3>
          <div class="meta">
            <span class="${statusClass(s.status)}">${escapeHtml(s.status)}</span>
            <span>${escapeHtml(s.profileName || s.backend || "")}</span>
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
        renderSessionList();
      }, 140);
    });
  }
}

async function openSession(id) {
  const isNew = state.selectedId !== id;
  state.selectedId = id;
  if (isNew) {
    state.tab = "transcript";
    state.diff = null;
    state.approvalDraftComment = "";
    state.streamingText = "";
  }
  try {
    state.detail = await Api.session(id);
    trackHighestSeq(state.detail);
    renderSessionList();
    renderDetail();
    $("#view-sessions").classList.add("detail-open");
  } catch (e) {
    banner(e.message, true);
  }
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
        ${
          d.archived
            ? `<button type="button" class="secondary" id="btn-unarch">Unarchive</button>`
            : `<button type="button" class="secondary" id="btn-arch">Archive</button>`
        }
        <button type="button" class="danger" id="btn-cancel">Cancel</button>
      </div>
    </div>

    <div class="detail-tabs" role="tablist">
      <button type="button" data-tab="transcript" class="${state.tab === "transcript" ? "active" : ""}">Transcript</button>
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
        ? `<div class="followup">
            <input id="followup-input" placeholder="Message agent… (Enter to send)" />
            <button type="button" class="primary" id="btn-send">Send</button>
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

  $("#btn-arch")?.addEventListener("click", async () => {
    try {
      await Api.archive(d.id);
      banner("Archived");
      state.detail = null;
      state.selectedId = null;
      await refreshSessions();
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-unarch")?.addEventListener("click", async () => {
    try {
      state.detail = await Api.unarchive(d.id);
      trackHighestSeq(state.detail);
      banner("Restored");
      await refreshSessions();
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-cancel")?.addEventListener("click", async () => {
    try {
      state.detail = await Api.cancel(d.id);
      trackHighestSeq(state.detail);
      await refreshSessions();
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });

  wireApprovalControls(d, pendingA);
  wireQuestionControls(d, pendingQ);

  const send = async () => {
    const input = $("#followup-input");
    const text = input?.value?.trim();
    if (!text) return;
    try {
      state.detail = await Api.prompt(d.id, { prompt: text });
      trackHighestSeq(state.detail);
      renderDetail();
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

  scrollTranscriptToEnd();
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
  const entries = (d.transcript || []).map((e) => ({ kind: "entry", at: e.at, data: e }));
  const tools = (d.toolCalls || []).map((t) => ({ kind: "tool", at: t.updatedAt, data: t }));
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
  return `<div class="${cls}${isStreaming ? " streaming" : ""}">
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
    ${path ? `<span class="tool-path">${escapeHtml(path)}</span>` : ""}
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
      <summary>${escapeHtml(f.path || "file")} <span class="diff-stat">${f.additions ?? "?"}+/${f.deletions ?? "?"}−</span></summary>
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
  if (!tasks.length && !notes.length) return `<div class="list-empty">No notes or tasks.</div>`;
  const tasksHtml = tasks.length
    ? `<h4 class="section-h">Tasks</h4><ul class="notes-list">${tasks
        .map(
          (t) => `<li class="note-item ${escapeAttr(t.status || "open")}">
        <span class="dot"></span>
        <span>${escapeHtml(t.text)}</span>
      </li>`,
        )
        .join("")}</ul>`
    : "";
  const notesHtml = notes.length
    ? `<h4 class="section-h">Notes</h4><ul class="notes-list">${notes
        .map((n) => `<li class="note-item"><span class="dot"></span><span>${escapeHtml(n.text)}</span></li>`)
        .join("")}</ul>`
    : "";
  return `<div class="notes-wrap">${tasksHtml}${notesHtml}</div>`;
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
      Api.profiles().catch(() => ({ profiles: [] })),
    ]);
    state.sessions = sessions.sessions || [];
    state.archived = sessions.archivedSessions || [];
    state.disk = sessions.diskSessions || [];
    state.claude = sessions.claudeSessions || [];
    state.projects = projects.projects || [];
    state.profiles = profiles.profiles || [];
    if (!state.profileId && state.profiles[0]) state.profileId = state.profiles[0].id;
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
    } else if (state.nav === "compose") {
      renderCompose();
    }
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
  }

  if (["session.created", "session.updated", "session.completed", "session.failed"].includes(ev.type)) {
    if (state.nav === "sessions" && (!state.selectedId || sid !== state.selectedId)) {
      renderSessionList();
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

// ——— Compose ———

function renderCompose() {
  const root = $("#view-compose");
  const opts = state.projects
    .map(
      (p) =>
        `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)} — ${escapeHtml(p.path)}</option>`,
    )
    .join("");
  const profile = state.profiles.find((p) => p.id === state.profileId);
  root.innerHTML = `
    <div class="compose-grid">
      <div class="card">
        <h3>Dispatch a task</h3>
        <p class="hint">Runs on the host machine under ${escapeHtml(profile?.name || "default profile")}.</p>
        <label class="field">Project</label>
        <div class="row-inline">
          <select id="c-project">${opts || `<option value="">(add projects in Host settings)</option>`}</select>
          <button type="button" class="secondary" id="c-add-folder">Add folder…</button>
        </div>
        <label class="field">Title (optional)</label>
        <input id="c-title" placeholder="Short name" />
        <label class="field">Prompt</label>
        <textarea id="c-prompt" placeholder="What should the agent do?"></textarea>
        <label class="check"><input type="checkbox" id="c-plan" checked /> Plan mode</label>
        <label class="check"><input type="checkbox" id="c-wt" checked /> Worktree</label>
        <div class="inline-actions">
          <button type="button" class="primary" id="c-go">Spank a clanker</button>
        </div>
      </div>
    </div>`;
  $("#c-add-folder")?.addEventListener("click", async () => {
    const dir = await window.clanker.pickDirectory();
    if (!dir) return;
    const cfgRes = await window.clanker.getHostConfig();
    const cfg = cfgRes.config || {};
    const projects = [...(cfg.projects || [])];
    const id = `project-${projects.length + 1}`;
    projects.push({ id, name: dir.split("/").pop() || id, path: dir });
    await window.clanker.saveHostConfig({ ...cfg, projects });
    banner(`Added ${dir}`);
    await refreshSessions();
    renderCompose();
    const sel = $("#c-project");
    if (sel) sel.value = id;
  });
  $("#c-go")?.addEventListener("click", async () => {
    const prompt = $("#c-prompt").value.trim();
    if (!prompt) {
      banner("Write a prompt first", true);
      return;
    }
    try {
      const detail = await Api.dispatch({
        prompt,
        projectId: $("#c-project").value || undefined,
        title: $("#c-title").value.trim() || undefined,
        planMode: $("#c-plan").checked,
        worktree: $("#c-wt").checked,
        subagents: true,
        profileId: state.profileId || undefined,
      });
      banner("Dispatched");
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
  const rows = kind === "claude" ? state.claude : state.disk;
  if (!rows.length) {
    root.innerHTML = `<div class="list-empty">No ${kind === "claude" ? "Claude" : "Grok"} sessions on disk.</div>`;
    return;
  }
  root.innerHTML = `<div class="stack-gap" style="max-width:720px">${rows
    .map((d) => {
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
          <input data-k="path" placeholder="/path/to/repo" value="${escapeAttr(p.path)}" />
          <button type="button" class="ghost" data-browse="${i}">…</button>
        </div>`,
          )
          .join("") || `<p class="hint">No projects — add one.</p>`;
      projectsRoot.querySelectorAll(".project-row").forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelectorAll("input").forEach((inp) => {
          inp.addEventListener("change", () => {
            projects[i][inp.dataset.k] = inp.value;
          });
        });
      });
      projectsRoot.querySelectorAll("[data-browse]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const i = Number(btn.getAttribute("data-browse"));
          const dir = await window.clanker.pickDirectory();
          if (dir) {
            projects[i].path = dir;
            drawProjects();
          }
        });
      });
    };
    drawProjects();
    $("#hc-add-project")?.addEventListener("click", () => {
      projects.push({ id: `project-${projects.length + 1}`, name: "Project", path: "" });
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
      projects: state._editProjects || cfg.projects,
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

  state.refreshTimer = setInterval(async () => {
    await refreshHostStatus();
    if (state.wsStatus !== "live") await refreshSessions();
  }, 8000);
}

boot().catch((e) => {
  console.error(e);
  banner(e.message || String(e), true);
});
