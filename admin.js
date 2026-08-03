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
const BADGES = (CFG.callouts && CFG.callouts.badges) || [];
const NAME_SEP = ", ";        // no commander name on record contains a comma
const badgeByKey = (k) => BADGES.find((b) => b.key === k) || null;

const state = { type: "announcement", password: "", rows: [], roster: [], names: [], badge: "" };

/* ------------------------------------------------------------ transport */

async function apiGet(params) {
  const res = await fetch(API + "?" + new URLSearchParams(params), { redirect: "follow", credentials: "omit" });
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
    // see app.js fetchJson — Google cookies make Apps Script answer 404/HTML
    credentials: "omit",
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

/** "a, b" -> ["a","b"]; tolerates stray spacing and a trailing separator. */
function splitNames(v) {
  return String(v == null ? "" : v).split(",").map((s) => s.trim()).filter(Boolean);
}

function normaliseRow(r) {
  return {
    id: String(r.Id == null ? "" : r.Id).trim(),
    type: String(r.Type == null ? "" : r.Type).trim().toLowerCase() === "shoutout" ? "shoutout" : "announcement",
    names: splitNames(r.Commander),
    badge: String(r.Badge == null ? "" : r.Badge).trim(),
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

/* Same avatar index the public site reads, so the picker shows real faces
   rather than initials. Missing entries fall back to a letter tile. */
const AVATARS = {};
async function loadAvatarIndex() {
  try {
    const res = await fetch("assets/commanders/index.json", { cache: "no-cache" });
    Object.assign(AVATARS, await res.json());
  } catch (_) { /* initials everywhere is a fine degradation */ }
}

function letterTile(name, cls) {
  const box = el("div", cls || "callout-icon", (name || "?").trim().slice(0, 1).toUpperCase());
  box.style.fontFamily = "var(--font-num)";
  box.style.color = "var(--taegeuk-blue)";
  return box;
}

function adminAvatar(name, size) {
  const src = AVATARS[name];
  if (!src) return letterTile(name);
  const img = el("img", "avatar");
  img.src = src;
  img.alt = name;
  img.loading = "lazy";
  if (size) { img.width = size; img.height = size; }
  img.addEventListener("error", () => img.replaceWith(letterTile(name)), { once: true });
  return img;
}

function calloutCard(c, opts = {}) {
  const card = el("div", "callout callout-" + c.type);

  // one avatar per named commander, so a group shoutout reads as a group
  if (c.type === "shoutout" && c.names.length) {
    const stack = el("div", "callout-faces");
    for (const n of c.names.slice(0, 6)) stack.appendChild(adminAvatar(n));
    card.appendChild(stack);
  } else {
    card.appendChild(el("div", "callout-icon", "!"));
  }

  const body = el("div", "callout-body");
  const head = el("div", "callout-head");
  head.appendChild(el("span", "callout-flag", c.type === "shoutout" ? "Shoutout" : "Announcement"));
  if (c.type === "shoutout" && c.names.length) {
    head.appendChild(el("span", "callout-name", c.names.join(NAME_SEP)));
  }
  const b = badgeByKey(c.badge);
  if (b) {
    const chip = el("span", "callout-badge");
    chip.appendChild(el("span", "callout-badge-icon", b.icon));
    chip.appendChild(document.createTextNode(b.label));
    head.appendChild(chip);
  }
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
    (v) => {
      state.type = v;
      renderTypeTabs();
      syncTemplates();
      renderPreview();
    });
  // commanders and badges belong to a shoutout; an announcement has neither
  const isShout = state.type === "shoutout";
  $("#commanderField").classList.toggle("hidden", !isShout);
  $("#badgeField").classList.toggle("hidden", !isShout);
}

function templatesForType() {
  return TEMPLATES.filter((t) => (t.type || "announcement") === state.type);
}

/* True while the message box still holds template text (or nothing), so
   switching type can swap the prefill without destroying anything typed. */
function messageIsPristine() {
  const cur = $("#messageInput").value.trim();
  if (!cur) return true;
  return TEMPLATES.some((t) => (t.text || "").trim() === cur);
}

/** Populate the picker and pre-select the first template of this type. */
function syncTemplates() {
  const sel = $("#templateSelect");
  const mine = templatesForType();
  const pristine = messageIsPristine();

  sel.innerHTML = "";
  mine.forEach((t, i) => sel.appendChild(new Option(t.label || "Template " + (i + 1), String(i))));
  sel.disabled = mine.length === 0;

  if (!mine.length) return;
  sel.value = "0";
  if (pristine) $("#messageInput").value = mine[0].text || "";
}

function applyTemplate() {
  const t = templatesForType()[Number($("#templateSelect").value)];
  if (t) $("#messageInput").value = t.text || "";
  renderPreview();
}

function renderBadges() {
  const sel = $("#badgeSelect");
  sel.innerHTML = "";
  sel.appendChild(new Option("— none —", ""));
  for (const b of BADGES) sel.appendChild(new Option(`${b.icon}  ${b.label}`, b.key));
  sel.value = state.badge;
}

/* ---- commander chips ---- */

function addCommander(raw) {
  const name = (raw || "").trim();
  if (!name) return;
  // free text is allowed on purpose: non-members and ad-hoc groups still work
  if (!state.names.includes(name)) state.names.push(name);
  $("#commanderInput").value = "";
  renderCommanderChips();
  renderRosterGrid("");
  renderPreview();
}

/** Clickable roster, visible without typing. Filter narrows it live. */
function renderRosterGrid(filter) {
  const grid = $("#rosterGrid");
  if (!grid) return;
  const q = (filter || "").trim().toLowerCase();
  const list = state.roster.filter((n) => !q || n.toLowerCase().includes(q));

  grid.innerHTML = "";
  if (!state.roster.length) {
    grid.appendChild(el("p", "hint", "Roster unavailable — type names by hand."));
    return;
  }
  if (!list.length) {
    grid.appendChild(el("p", "hint", `Nobody matches "${filter}" — press Enter to add it as a name anyway.`));
    return;
  }

  for (const n of list) {
    const picked = state.names.includes(n);
    const cell = el("button", "roster-pick" + (picked ? " picked" : ""));
    cell.type = "button";
    cell.title = n;
    cell.setAttribute("aria-pressed", String(picked));
    cell.appendChild(adminAvatar(n, 44));
    cell.appendChild(el("span", "roster-pick-name", n));
    cell.addEventListener("click", () => {
      if (state.names.includes(n)) state.names = state.names.filter((m) => m !== n);
      else state.names.push(n);
      renderCommanderChips();
      renderRosterGrid($("#commanderInput").value);
      renderPreview();
    });
    grid.appendChild(cell);
  }
}

function renderCommanderChips() {
  const box = $("#commanderChips");
  box.innerHTML = "";
  for (const n of state.names) {
    const chip = el("span", "chip", n);
    const x = el("button", null, "×");
    x.type = "button";
    x.setAttribute("aria-label", "Remove " + n);
    x.addEventListener("click", () => {
      state.names = state.names.filter((m) => m !== n);
      renderCommanderChips();
      renderRosterGrid($("#commanderInput").value);
      renderPreview();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  }
  const known = state.names.filter((n) => state.roster.includes(n)).length;
  $("#commanderHint").textContent = state.names.length
    ? `${state.names.length} selected · ${known} from the roster`
    : "Click anyone below, or type a name that isn't on the roster.";
}

function draft() {
  const hours = Number($("#durationSelect").value);
  return {
    type: state.type,
    names: state.type === "shoutout" ? state.names.slice() : [],
    badge: state.type === "shoutout" ? state.badge : "",
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

  /* A dedicated check that writes nothing to the callout tab. This used to
     post a real callout and immediately expire it, which left an
     "(admin unlock check)" row in Shoutouts on every single login. The
     attempt is recorded in the Admin Log tab instead. */
  try {
    const res = await apiPost({ action: "callout_check", secret: pw, who: "admin.html" });
    if (!res.ok) {
      setStatus($("#lockStatus"),
        res.error === "unauthorized" ? "Password rejected." : ("Refused: " + res.error), "err");
      return;
    }
    state.password = pw;
    try { sessionStorage.setItem(PW_KEY, pw); } catch (_) {}
    enterAdmin();
  } catch (e) {
    // surface the real reason — a bare "could not reach" hid HTTP 405/404
    setStatus($("#lockStatus"), "Could not verify: " + (e.message || e), "err");
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
  if (d.type === "shoutout" && !d.names.length) { setStatus($("#postStatus"), "A shoutout needs at least one commander.", "err"); return; }

  $("#postBtn").disabled = true;
  setStatus($("#postStatus"), "Posting…", "");
  try {
    const res = await apiPost({
      action: "callout", secret: state.password, type: d.type,
      commander: d.names.join(NAME_SEP), badge: d.badge,
      message: d.message, hours: d.hours, author: d.author,
    });
    if (!res.ok) {
      setStatus($("#postStatus"), res.error === "unauthorized" ? "Password rejected." : ("Refused: " + res.error), "err");
      return;
    }
    setStatus($("#postStatus"), "Posted. It is live on the site now.", "ok");
    state.names = [];
    state.badge = "";
    $("#commanderInput").value = "";
    $("#messageInput").value = "";        // cleared, so syncTemplates re-prefills
    renderCommanderChips();
    renderRosterGrid("");
    renderBadges();
    syncTemplates();
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
    state.roster = names;
    renderCommanderChips();
    renderRosterGrid($("#commanderInput").value);
  } catch (_) { /* suggestions are a nicety, not a requirement */ }
}

/* ------------------------------------------------------------ boot */

function boot() {
  $("#brandMark").textContent = CFG.name || "kWcl";

  renderTypeTabs();
  renderBadges();
  syncTemplates();
  renderCommanderChips();
  renderRosterGrid("");

  $("#unlockBtn").addEventListener("click", unlock);
  $("#pwInput").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  $("#templateSelect").addEventListener("change", applyTemplate);
  $("#messageInput").addEventListener("input", renderPreview);
  $("#commanderInput").addEventListener("input", (e) => renderRosterGrid(e.target.value));
  $("#commanderAdd").addEventListener("click", () => addCommander($("#commanderInput").value));
  $("#commanderInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCommander(e.target.value); }
  });
  $("#badgeSelect").addEventListener("change", (e) => { state.badge = e.target.value; renderPreview(); });
  $("#authorInput").addEventListener("input", renderPreview);
  $("#durationSelect").addEventListener("change", renderPreview);
  $("#postBtn").addEventListener("click", postCallout);
  $("#reloadBtn").addEventListener("click", loadActive);
  $("#clearBtn").addEventListener("click", () => {
    state.names = [];
    state.badge = "";
    $("#commanderInput").value = "";
    $("#messageInput").value = "";
    setStatus($("#postStatus"), "", "");
    renderCommanderChips();
    renderRosterGrid("");
    renderBadges();
    syncTemplates();
    renderPreview();
  });

  loadAvatarIndex().then(loadRoster);

  // Same tab, already unlocked — skip the lock screen without re-probing.
  let saved = "";
  try { saved = sessionStorage.getItem(PW_KEY) || ""; } catch (_) {}
  if (saved) { state.password = saved; enterAdmin(); }
}

boot();
