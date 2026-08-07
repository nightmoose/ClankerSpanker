"use strict";

const state = {
  nav: "sessions",
  showArchived: false,
  sessions: [],
  archived: [],
  disk: [],
  claude: [],
  projects: [],
  profiles: [],
  profileId: null,
  detail: null,
  selectedId: null,
  wsStatus: "offline",
  hostStatus: null,
  desktopConfig: null,
  hostConfig: null,
  hostConfigPath: "",
  refreshTimer: null,
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
  // Start when managed and nothing is already serving / owned by us
  const canStart = hs.mode === "managed" && !hs.startedByUs && !live;
  $("#btn-host-start").disabled = !canStart;
  $("#btn-host-stop").disabled = !(hs.running && hs.startedByUs);
}

function setWsPill(status) {
  state.wsStatus = status;
  const el = $("#ws-pill");
  el.textContent = status === "live" ? "live" : status === "connecting" ? "…" : "offline";
  el.classList.toggle("ok", status === "live");
  el.classList.toggle("warn", status === "connecting");
  el.classList.toggle("muted", status === "offline");
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
  // show profile bar + archived only on sessions
  $(".toolbar-right").classList.toggle("hidden", nav !== "sessions");
  $("#profile-bar").classList.toggle("hidden", nav !== "sessions" && nav !== "compose");

  ["sessions", "compose", "disk", "host", "settings"].forEach((id) => {
    const el = $(`#view-${id === "grok" || id === "claude" ? "disk" : id}`);
    // handled below
  });

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

function filteredSessions() {
  const all = state.showArchived ? state.archived : state.sessions;
  if (!state.profileId) return all;
  return all.filter((s) => {
    if (s.profileId) return s.profileId === state.profileId;
    const p = state.profiles.find((x) => x.id === state.profileId);
    if (!p) return true;
    return (s.backend || "grok") === p.backend;
  });
}

function renderSessionList() {
  const root = $("#session-list");
  const rows = filteredSessions();
  if (!Api.getConnection().token) {
    root.innerHTML = `<div class="list-empty">No host token yet.<br/>Open <strong>Host</strong> and start the gateway.</div>`;
    return;
  }
  if (!rows.length) {
    root.innerHTML = `<div class="list-empty">No ${state.showArchived ? "archived" : "active"} sessions.<br/>Use <strong>Compose</strong> to dispatch a task.</div>`;
    return;
  }
  root.innerHTML = rows
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

  root.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => openSession(el.getAttribute("data-open")));
  });
}

async function openSession(id) {
  state.selectedId = id;
  try {
    state.detail = await Api.session(id);
    renderSessionList();
    renderDetail();
    $("#view-sessions").classList.add("detail-open");
  } catch (e) {
    banner(e.message, true);
  }
}

function renderDetail() {
  const root = $("#session-detail");
  const d = state.detail;
  if (!d) {
    root.className = "panel detail-panel empty-detail";
    root.innerHTML = `<p class="muted-center">Select a session</p>`;
    return;
  }
  root.className = "panel detail-panel";
  const transcript = [...(d.transcript || [])];
  const pendingA = d.pendingApproval;
  const pendingQ = d.pendingQuestion;

  root.innerHTML = `
    <div class="detail-head">
      <div>
        <button type="button" class="ghost" id="btn-back-list" style="display:none;margin-bottom:8px">← Back</button>
        <h3>${escapeHtml(d.title)}</h3>
        <div class="meta">
          <span class="${statusClass(d.status)}">${escapeHtml(d.status)}</span>
          <span>${escapeHtml(d.model || "")}</span>
          <span title="${escapeAttr(d.cwd)}">${escapeHtml(shortPath(d.cwd))}</span>
          <span>${escapeHtml(d.profileName || d.backend || "")}</span>
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
    <div class="transcript" id="transcript">
      ${
        transcript.length
          ? transcript
              .map(
                (t) => `
        <div class="bubble ${t.role === "user" ? "user" : ""}">
          <div class="role">${escapeHtml(t.role)}</div>
          <div class="text">${escapeHtml(t.text || "")}</div>
        </div>`,
              )
              .join("")
          : `<div class="list-empty">No transcript yet.</div>`
      }
    </div>
    ${
      pendingA
        ? `<div class="approval">
            <strong>${escapeHtml(pendingA.title || "Approval needed")}</strong>
            <p class="preview">${escapeHtml([pendingA.kind, pendingA.detail || pendingA.path].filter(Boolean).join(" · "))}</p>
            <div class="inline-actions">
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
                ${(q.options || [])
                  .map((o) => `<option value="${escapeAttr(o.label)}">${escapeHtml(o.label)}</option>`)
                  .join("")}
              </select>`,
              )
              .join("")}
            <div class="inline-actions">
              <button type="button" class="primary" id="btn-answer">Submit answers</button>
            </div>
          </div>`
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

  // mobile back
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

  const scroll = $("#transcript");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

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
      await refreshSessions();
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-approve")?.addEventListener("click", async () => {
    try {
      state.detail = await Api.approve(d.id, { approvalId: pendingA.id });
      await refreshSessions();
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-reject")?.addEventListener("click", async () => {
    try {
      state.detail = await Api.reject(d.id, { approvalId: pendingA.id });
      await refreshSessions();
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
  $("#btn-answer")?.addEventListener("click", async () => {
    const answers = [...root.querySelectorAll("select[data-q]")].map((s) => s.value);
    try {
      state.detail = await Api.answer(d.id, { questionId: pendingQ.id, answers });
      await refreshSessions();
      renderDetail();
    } catch (e) {
      banner(e.message, true);
    }
  });
  const send = async () => {
    const input = $("#followup-input");
    const text = input?.value?.trim();
    if (!text) return;
    try {
      state.detail = await Api.prompt(d.id, { prompt: text });
      await refreshSessions();
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
}

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
    if (state.nav === "sessions") {
      renderSessionList();
      if (state.selectedId) {
        try {
          state.detail = await Api.session(state.selectedId);
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
        <select id="c-project">${opts || `<option value="">(add projects in Host settings)</option>`}</select>
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

  // projects editor
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

  // profiles editor
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
    const r = await window.clanker.regenerateToken();
    banner("Token regenerated — clients must update");
    await loadHostConfigPanel();
    await syncConnection();
    renderHost();
    if (r.token) {
      /* shown in field after re-render */
    }
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

  // scroll logs to end
  const logEl = $("#h-logs");
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

// ——— Desktop settings ———

function renderDesktopSettings() {
  const root = $("#view-settings");
  const d = state.desktopConfig || {};
  root.innerHTML = `
    <div class="settings-grid">
      <div class="card">
        <h3>Connection mode</h3>
        <label class="check"><input type="radio" name="mode" value="managed" ${d.mode !== "remote" ? "checked" : ""}/> <strong>Managed</strong> — this app starts/stops a local host (command center)</label>
        <label class="check"><input type="radio" name="mode" value="remote" ${d.mode === "remote" ? "checked" : ""}/> <strong>Remote</strong> — connect to an existing host (LAN / Tailscale)</label>
        <label class="field">Host URL (remote mode)</label>
        <input id="ds-url" value="${escapeAttr(d.hostURL || "http://127.0.0.1:8787")}" />
        <label class="field">Host token (remote; managed syncs from config file)</label>
        <input id="ds-token" value="${escapeAttr(d.token || "")}" spellcheck="false" />
        <label class="field">Host package path (optional override)</label>
        <input id="ds-hostpath" value="${escapeAttr(d.hostPackagePath || "")}" placeholder="auto: ../host" />
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

  $("#ds-browse-host")?.addEventListener("click", async () => {
    const dir = await window.clanker.pickDirectory();
    if (dir) $("#ds-hostpath").value = dir;
  });
  $("#ds-save")?.addEventListener("click", async () => {
    const mode = $$("input[name=mode]").find((r) => r.checked)?.value || "managed";
    state.desktopConfig = await window.clanker.saveDesktopConfig({
      mode,
      hostURL: $("#ds-url").value.trim(),
      token: $("#ds-token").value.trim(),
      hostPackagePath: $("#ds-hostpath").value.trim(),
      autoStartHost: $("#ds-autostart").checked,
      stopHostOnQuit: $("#ds-stopquit").checked,
      notifications: $("#ds-notify").checked,
      startMinimized: $("#ds-min").checked,
    });
    await syncConnection();
    await refreshHostStatus();
    await refreshSessions();
    banner("Desktop settings saved");
  });
}

// ——— Boot ———

function wireChrome() {
  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setNav(btn.dataset.nav));
  });
  $("#show-archived")?.addEventListener("change", (e) => {
    state.showArchived = e.target.checked;
    renderSessionList();
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
  window.clanker.onHostEvent(() => {
    // Live session updates
    refreshSessions();
  });
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
}

async function boot() {
  wireChrome();
  await syncConnection();
  await refreshHostStatus();
  await loadHostConfigPanel();
  setNav("sessions");
  await refreshSessions();

  // Poll host status + sessions gently
  state.refreshTimer = setInterval(async () => {
    await refreshHostStatus();
    if (state.wsStatus !== "live") await refreshSessions();
  }, 8000);
}

boot().catch((e) => {
  console.error(e);
  banner(e.message || String(e), true);
});
