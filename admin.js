/* ============================================================
   kWcl — Shoutouts admin

   Posts short, time-limited callouts through the password-guarded endpoint in
   Code.gs. The password is never stored in this file or in the repo: it is
   typed here, held in sessionStorage for the tab's lifetime, and verified
   server-side against the CALLOUT_SECRET script property. This page is only a
   convenience — it cannot grant access it does not have.
   ============================================================ */

const CFG = Object.assign(
  { name: "kWcl", apiUrl: "", callouts: {} },
  window.ALLIANCE_CONFIG || {}
);

const PW_KEY = "kwcl_admin_pw";
const API_KEY = "kwcl_api_url";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* Same override the public page honours, so a local mock can be pointed at
   without editing config.js. */
function getApiUrl() {
  const p = new URLSearchParams(location.search).get("api");
  if (p) { try { localStorage.setItem(API_KEY, p); } catch (_) {} return p; }
  try { return localStorage.getItem(API_KEY) || CFG.apiUrl; } catch (_) { return CFG.apiUrl; }
}

const API = (getApiUrl() || "").replace(/\/+$/, "");
const SHEET = (CFG.callouts && CFG.callouts.sheet) || "Shoutouts";
const TEMPLATES = (CFG.callouts && CFG.callouts.templates) || [];

const state = { type: "announcement", password: "", rows: [], roster: [] };

/* ------------------------------------------------------------ transport */

async function apiGet(params) {
  const res = await fetch(API + "?" + new URLSearchParams(params), { redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* Apps Script rejects a preflight, so this posts text/plain — a "simple
   request" in CORS terms, which the browser sends without an OPTIONS round
   trip. doPost parses the body as JSON regardless of the declared type. */
async function apiPost(body) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
    redirect: "follow",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* ------------------------------------------------------------ shared shape */

function calloutExpiry(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

function normaliseRow(r) {
  return {
    id: String(r.Id == null ? "" : r.Id).trim(),
    type: String(r.Type == null ? "" : r.Type).trim().toLowerCase() === "shoutout" ? "shoutout" : "announcement",
    name: String(r.Commander == null ? "" : r.Commander).trim(),
    message: String(r.Message == null ? "" : r.Message).trim(),
    created: String(r.Created == null ? "" : r.Created).trim(),
    expires: calloutExpiry(r.Expires),
    author: String(r.Author == null ? "" : r.Author).trim(),
  };
}

function untilLabel(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins >= 1440) return Math.round(mins / 1440) + "d left";
  if (mins >= 60) return Math.round(mins / 60) + "h left";
  return mins + "m left";
}

/* A deliberately plain stand-in for the site's avatar plate: the admin page
   does not need the identity-plate generator, only a recognisable square. */
function adminAvatar(name) {
  const box = el("div", "callout-icon", (name || "?").trim().slice(0, 1).toUpperCase());
  box.style.fontFamily = "var(--font-num)";
  box.style.color = "var(--taegeuk-blue)";
  return box;
}

function calloutCard(c, opts = {}) {
  const card = el("div", "callout callout-" + c.type);
  card.appendChild(c.type === "shoutout" && c.name ? adminAvatar(c.name) : el("div", "callout-icon", "!"));

  const body = el("div", "callout-body");
  const head = el("div", "callout-head");
  head.appendChild(el("span", "callout-flag", c.type === "shoutout" ? "Shoutout" : "Announcement"));
  if (c.type === "shoutout" && c.name) head.appendChild(el("span", "callout-name", c.name));
  body.appendChild(head);

  const msg = el("p", "callout-msg");
  msg.textContent = c.message || "…";
  body.appendChild(msg);

  const meta = [];
  if (c.author) meta.push(c.author);
  if (c.expires !== null) meta.push(untilLabel(c.expires - Date.now()));
  else meta.push("until removed");
  body.appendChild(el("div", "callout-meta", meta.join(" · ")));

  card.appendChild(body);

  if (opts.removable) {
    const btn = el("button", "btn-ghost", "Remove now");
    btn.type = "button";
    btn.addEventListener("click", () => removeCallout(c, btn));
    const wrap = el("div", "callout-actions");
    wrap.appendChild(btn);
    card.appendChild(wrap);
  }
  return card;
}

/* ------------------------------------------------------------ composer */

function segTabs(container, options, selected, onPick) {
  container.innerHTML = "";
  for (const o of options) {
    const b = el("button", null, o.label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(o.value === selected));
    b.addEventListener("click", () => onPick(o.value));
    container.appendChild(b);
  }
}

function renderTypeTabs() {
  segTabs($("#typeTabs"),
    [{ value: "announcement", label: "Announcement" }, { value: "shoutout", label: "Shoutout" }],
    state.type,
    (v) => { state.type = v; renderTypeTabs(); syncTemplates(); renderPreview(); });
  // A shoutout is about a person; an announcement is not.
  $("#commanderField").classList.toggle("hidden", state.type !== "shoutout");
}

/** Show only the templates belonging to the selected type. */
function syncTemplates() {
  const sel = $("#templateSelect");
  const mine = TEMPLATES.filter((t) => (t.type || "announcement") === state.type);
  sel.innerHTML = "";
  sel.appendChild(new Option("— blank —", ""));
  mine.forEach((t, i) => sel.appendChild(new Option(t.label || "Template " + (i + 1), String(i))));
  sel.disabled = mine.length === 0;
}

function applyTemplate() {
  const mine = TEMPLATES.filter((t) => (t.type || "announcement") === state.type);
  const i = $("#templateSelect").value;
  if (i === "") return;
  const t = mine[Number(i)];
  if (t) $("#messageInput").value = t.text || "";
  renderPreview();
}

function draft() {
  const hours = Number($("#durationSelect").value);
  return {
    type: state.type,
    name: $("#commanderInput").value.trim(),
    message: $("#messageInput").value.trim(),
    author: $("#authorInput").value.trim(),
    expires: hours > 0 ? Date.now() + hours * 3600 * 1000 : null,
    hours,
  };
}

function renderPreview() {
  const list = $("#previewList");
  list.innerHTML = "";
  list.appendChild(calloutCard(draft()));
}

/* ------------------------------------------------------------ actions */

function setStatus(node, msg, kind) {
  node.textContent = msg;
  node.className = "settings-status" + (kind ? " " + kind : "");
}

async function unlock() {
  const pw = $("#pwInput").value;
  if (!pw) { setStatus($("#lockStatus"), "Enter the password.", "err"); return; }
  if (!API) { setStatus($("#lockStatus"), "No API URL configured.", "err"); return; }

  setStatus($("#lockStatus"), "Checking…", "");

  /* There is no "verify password" endpoint by design — the only thing that can
     confirm the secret is a real write. So this posts a callout that expires
     immediately, then removes it: a wrong password is refused before anything
     is written, and a right one leaves nothing visible on the site. */
  try {
    const probe = await apiPost({
      action: "callout", secret: pw, type: "announcement",
      message: "(admin unlock check)", hours: 0,
    });
    if (!probe.ok) {
      setStatus($("#lockStatus"),
        probe.error === "unauthorized" ? "Password rejected." : ("Refused: " + probe.error), "err");
      return;
    }
    await apiPost({ action: "callout_expire", secret: pw, id: probe.id });

    state.password = pw;
    try { sessionStorage.setItem(PW_KEY, pw); } catch (_) {}
    enterAdmin();
  } catch (e) {
    setStatus($("#lockStatus"), "Could not reach the API: " + (e.message || e), "err");
  }
}

function enterAdmin() {
  $("#lockSection").classList.add("hidden");
  $("#composeSection").classList.remove("hidden");
  $("#activeSection").classList.remove("hidden");
  $("#dataPill").textContent = "UNLOCKED";
  $("#dataPill").classList.add("live");
  renderPreview();
  loadActive();
}

async function postCallout() {
  const d = draft();
  if (!d.message) { setStatus($("#postStatus"), "Write a message first.", "err"); return; }
  if (d.type === "shoutout" && !d.name) { setStatus($("#postStatus"), "A shoutout needs a commander.", "err"); return; }

  $("#postBtn").disabled = true;
  setStatus($("#postStatus"), "Posting…", "");
  try {
    const res = await apiPost({
      action: "callout", secret: state.password, type: d.type,
      commander: d.name, message: d.message, hours: d.hours, author: d.author,
    });
    if (!res.ok) {
      setStatus($("#postStatus"), res.error === "unauthorized" ? "Password rejected." : ("Refused: " + res.error), "err");
      return;
    }
    setStatus($("#postStatus"), "Posted. It is live on the site now.", "ok");
    $("#messageInput").value = "";
    $("#commanderInput").value = "";
    $("#templateSelect").value = "";
    renderPreview();
    await loadActive();
  } catch (e) {
    setStatus($("#postStatus"), "Failed: " + (e.message || e), "err");
  } finally {
    $("#postBtn").disabled = false;
  }
}

async function removeCallout(c, btn) {
  btn.disabled = true;
  btn.textContent = "Removing…";
  try {
    const res = await apiPost({ action: "callout_expire", secret: state.password, id: c.id });
    if (!res.ok) { btn.disabled = false; btn.textContent = "Remove now"; setStatus($("#postStatus"), "Refused: " + res.error, "err"); return; }
    await loadActive();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Remove now";
    setStatus($("#postStatus"), "Failed: " + (e.message || e), "err");
  }
}

async function loadActive() {
  const list = $("#activeList");
  const hint = $("#activeHint");
  try {
    const json = await apiGet({ action: "data", sheet: SHEET });
    state.rows = (json.data || []).map(normaliseRow).filter((r) => r.message);
  } catch (_) {
    hint.textContent = "Could not read the Shoutouts tab.";
    return;
  }

  const now = Date.now();
  const active = state.rows
    .filter((c) => c.expires === null || c.expires > now)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));

  list.innerHTML = "";
  for (const c of active) list.appendChild(calloutCard(c, { removable: true }));

  const expired = state.rows.length - active.length;
  hint.textContent = active.length
    ? `${active.length} showing on the site${expired ? ` · ${expired} expired (kept in the sheet)` : ""}`
    : "Nothing is showing on the site right now.";
}

/** Roster names for the commander datalist. Failure is non-fatal — the input
    still accepts free text, it just stops suggesting. */
async function loadRoster() {
  try {
    const json = await apiGet({ action: "data", sheet: "Roster" });
    const names = (json.data || [])
      .filter((r) => String(r.isActive).toUpperCase() !== "FALSE")
      .map((r) => String(r.Commander == null ? "" : r.Commander).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const dl = $("#rosterList");
    dl.innerHTML = "";
    for (const n of names) dl.appendChild(new Option(n));
    state.roster = names;
  } catch (_) { /* suggestions are a nicety, not a requirement */ }
}

/* ------------------------------------------------------------ boot */

function boot() {
  $("#brandMark").textContent = CFG.name || "kWcl";

  renderTypeTabs();
  syncTemplates();

  $("#unlockBtn").addEventListener("click", unlock);
  $("#pwInput").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  $("#templateSelect").addEventListener("change", applyTemplate);
  $("#messageInput").addEventListener("input", renderPreview);
  $("#commanderInput").addEventListener("input", renderPreview);
  $("#authorInput").addEventListener("input", renderPreview);
  $("#durationSelect").addEventListener("change", renderPreview);
  $("#postBtn").addEventListener("click", postCallout);
  $("#reloadBtn").addEventListener("click", loadActive);
  $("#clearBtn").addEventListener("click", () => {
    $("#messageInput").value = ""; $("#commanderInput").value = "";
    $("#templateSelect").value = ""; setStatus($("#postStatus"), "", "");
    renderPreview();
  });

  loadRoster();

  // Same tab, already unlocked — skip the lock screen without re-probing.
  let saved = "";
  try { saved = sessionStorage.getItem(PW_KEY) || ""; } catch (_) {}
  if (saved) { state.password = saved; enterAdmin(); }
}

boot();
