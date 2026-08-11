/* ============================================================
   kWcl — Shoutouts admin

   Posts short, time-limited callouts through the password-guarded endpoint in
   Code.gs. The password is never stored in this file or in the repo: it is
   typed here, kept in the browser's own storage, and verified server-side
   against the CALLOUT_SECRET script property. This page is only a convenience
   — it cannot grant access it does not have.
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

/* ------------------------------------------------------------ the session

   The password lives in localStorage, not sessionStorage. A per-tab secret
   meant retyping it on every visit: this page is opened from a phone home
   screen and from a laptop bookmark, and each of those is a fresh tab.

   The trade is that the secret now outlives the tab, so two things bound it —
   the lock button in the header, and any "unauthorized" answer from Code.gs,
   which drops the stored copy on the spot rather than leaving a dead session
   sitting behind an UNLOCKED pill.
   ---------------------------------------------------------------------- */

function loadPw() {
  try {
    const saved = localStorage.getItem(PW_KEY);
    if (saved) return saved;
    // A tab unlocked before this page moved to localStorage: carry it over
    // once so the switch does not cost the one person mid-session a retype.
    const legacy = sessionStorage.getItem(PW_KEY);
    if (legacy) {
      localStorage.setItem(PW_KEY, legacy);
      sessionStorage.removeItem(PW_KEY);
      return legacy;
    }
  } catch (_) {}
  return "";
}

function savePw(pw) {
  try { localStorage.setItem(PW_KEY, pw); } catch (_) {}
}

function clearPw() {
  try {
    localStorage.removeItem(PW_KEY);
    sessionStorage.removeItem(PW_KEY);
  } catch (_) {}
}

const API = (getApiUrl() || "").replace(/\/+$/, "");
const SHEET = (CFG.callouts && CFG.callouts.sheet) || "Shoutouts";
const TEMPLATES = (CFG.callouts && CFG.callouts.templates) || [];
const BADGES = (CFG.callouts && CFG.callouts.badges) || [];
const NAME_SEP = ", ";        // no commander name on record contains a comma
const badgeByKey = (k) => BADGES.find((b) => b.key === k) || null;

const state = { type: "shoutout", password: "", rows: [], roster: [], names: [], badge: "" };

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

/* Apps Script intermittently answers a perfectly good POST with 404 and an
   HTML body: the write lands, the response does not. Retrying blindly would
   post the callout twice, so a lost response is resolved by reading the sheet
   back — the same discipline push.py uses for the daily snapshot.

   `verify` returns true when the intended effect is visible in the sheet. A
   definitive refusal (unauthorized, validation error) is returned as-is; only
   a lost response is retried. */
async function postThenVerify(body, verify, tries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await apiPost(body);
      if (res && (res.ok || res.error)) return res;   // the server answered
    } catch (e) { lastErr = e; }

    try { if (await verify()) return { ok: true, recovered: true }; } catch (_) {}

    if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  throw lastErr || new Error("could not confirm the write");
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

/* A row whose Type this site does not recognise renders as an announcement —
   the safe default — while a configured one-tap alert keeps its own identity
   instead of being flattened into one.

   Driven by config, not a hard-coded list: removing an alert from config.js
   should make its old rows degrade quietly rather than render a marker for
   something the alliance no longer runs. */
function alertKinds() {
  return (CFG.alerts || []).filter((a) => a && a.key);
}
function alertFor(key) {
  return alertKinds().find((a) => a.key === key) || null;
}
function calloutType(v) {
  const t = String(v == null ? "" : v).trim().toLowerCase();
  if (t === "shoutout") return "shoutout";
  return alertFor(t) ? t : "announcement";
}

function normaliseRow(r) {
  return {
    id: String(r.Id == null ? "" : r.Id).trim(),
    type: calloutType(r.Type),
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
  const kind = alertFor(c.type);
  const flag = c.type === "shoutout" ? "Shoutout"
             : kind ? (kind.icon || "❗") + " " + ((kind.label && kind.label.en) || kind.key)
             : "Announcement";
  head.appendChild(el("span", "callout-flag", flag));
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
    [{ value: "shoutout", label: "Shoutout" }, { value: "announcement", label: "Announcement" }],
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
    // only writes an Admin Log line, so retrying a lost response is harmless
    const res = await postThenVerify(
      { action: "callout_check", secret: pw, who: "admin.html" },
      async () => false);
    if (!res.ok) {
      setStatus($("#lockStatus"),
        res.error === "unauthorized" ? "Password rejected." : ("Refused: " + res.error), "err");
      return;
    }
    state.password = pw;
    savePw(pw);
    enterAdmin();
  } catch (e) {
    // surface the real reason — a bare "could not reach" hid HTTP 405/404
    setStatus($("#lockStatus"), "Could not verify: " + (e.message || e), "err");
  }
}

function enterAdmin() {
  // Belongs here, not at the call site: enterAdmin has two callers — typing
  // the password, and restoring it from storage on a revisit. Wiring this into
  // only the first left every returning admin with a blank count and a Post
  // button that never restated the notify choice.
  //
  // It doubles as the check on a restored session. refreshNotifyCount already
  // posts push_list with the stored secret, and Code.gs answers a bad one with
  // "unauthorized" — so a stale password is caught on load, for free, without
  // the extra callout_check that would put a login line in Admin Log on every
  // single revisit.
  refreshNotifyCount();
  renderAlertUi();
  $("#lockSection").classList.add("hidden");
  $("#composeSection").classList.remove("hidden");
  $("#activeSection").classList.remove("hidden");
  const lockBtn = $("#lockBtn");
  if (lockBtn) lockBtn.classList.remove("hidden");
  $("#dataPill").textContent = "UNLOCKED";
  $("#dataPill").classList.add("live");
  renderPreview();
  loadActive();
}

/**
 * End the session and go back to the lock screen.
 *
 * The one way out, and the only thing that erases the stored password. Called
 * by the lock button, and by every refusal Code.gs marks "unauthorized" — once
 * the password can outlive the tab, a password that has since been changed on
 * the server must not keep presenting an unlocked page.
 */
function lockOut(msg) {
  state.password = "";
  clearPw();
  if (alertTick) { clearInterval(alertTick); alertTick = null; }
  $("#composeSection").classList.add("hidden");
  $("#activeSection").classList.add("hidden");
  const alerts = $("#alertSection");
  if (alerts) alerts.classList.add("hidden");
  const lockBtn = $("#lockBtn");
  if (lockBtn) lockBtn.classList.add("hidden");
  $("#lockSection").classList.remove("hidden");
  $("#dataPill").textContent = "LOCKED";
  $("#dataPill").classList.remove("live");
  $("#pwInput").value = "";
  setStatus($("#lockStatus"), msg || "", msg ? "err" : "");
  $("#pwInput").focus();
}

/**
 * Report a refusal from Code.gs, ending the session if it was the password.
 *
 * Shared by every write so a rejected password locks the whole page, rather
 * than only the one panel that happened to make the failing call.
 */
function showRefusal(node, res) {
  if (res.error === "unauthorized") {
    lockOut("That password is no longer accepted. Please enter it again.");
    return;
  }
  setStatus(node, "Refused: " + res.error, "err");
}

/* ==================================================== push notifications

   The admin browser does the whole job of a push server: it fetches the VAPID
   key, encrypts one message per subscriber, and hands the finished bytes to
   Code.gs to POST. Apps Script cannot do the crypto (no ECDSA, no AES-GCM) and
   this page cannot do the delivery (FCM and Apple refuse a browser-origin
   POST — they answer the CORS preflight with no Access-Control-Allow-Origin).
   Splitting it that way is the only route that needs no extra service.

   push/crypto.js is an ES module and this file is a classic script, so it is
   pulled in with a dynamic import the first time a notification is sent.
   ==================================================================== */

/**
 * apiPost with retries, for the push endpoints.
 *
 * The callout path already has postThenVerify for this; the push calls need
 * the same protection for the same reason. Apps Script loses POSTs two ways:
 * an HTML 404, or a redirect that degrades to a GET so doPost never runs and
 * the reply is doGet's default output — the first sheet, as valid JSON. Both
 * are indistinguishable from success unless the shape is checked.
 *
 * `shapeOk` says what a real answer for THIS action looks like. A reply that
 * fails it never reached doPost, so it is worth asking again. A JSON reply
 * with ok:false is a genuine refusal and is returned immediately.
 */
async function pushPost(body, shapeOk, tries = 3) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await apiPost(body);
      if (res && res.ok === false) return res;          // a real "no"
      if (res && (!shapeOk || shapeOk(res))) return res;
      last = new Error("unrecognised reply from " + body.action);
    } catch (e) { last = e; }
    if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  throw last || new Error("no answer from " + body.action);
}

const PUSH_BATCH = 20;          // keep each relay call small and retryable
let pushCrypto = null;          // lazily imported module
let lastNotify = null;          // context for the retry button

async function loadPushCrypto() {
  if (!pushCrypto) pushCrypto = await import("./push/crypto.js");
  return pushCrypto;
}

/* ============================================== one-tap quick alerts

   One button per entry in config.alerts. Nothing to compose — the whole value
   is speed, since these are only worth announcing while they are still open.

   Two taps, though. A single button that notifies the entire alliance will
   eventually be hit by accident, and a false alert costs more than the second
   it saves, so the first tap only arms it.
   ==================================================================== */

let armedKey = "";          // which alert is waiting for its confirming tap
let armTimer = null;
let alertTick = null;
const alertCooldown = {};   // key -> timestamp the button becomes usable again

/* Only long enough to swallow a double-tap. Deliberately not the length of the
   marker: two treasures can be dug minutes apart, and locking the button for
   the whole window would leave the second one unannounced. */
function cooldownMs() {
  const s = Number(CFG.alertCooldownSeconds);
  return (s > 0 ? s : 10) * 1000;
}

/** The live row for one alert kind, if there is one. */
function liveAlert(key) {
  const now = Date.now();
  return (state.rows || [])
    .filter((r) => r.type === key && (r.expires === null || r.expires > now))
    .sort((a, b) => (b.expires || 0) - (a.expires || 0))[0] || null;
}

function buildAlertPanel() {
  const panel = $("#alertPanel");
  const sec = $("#alertSection");
  if (!panel || !sec) return;

  const kinds = alertKinds();
  // The section still earns its place with no alert buttons at all, as long as
  // quick announce is on.
  if (!kinds.length && !quickCfg().enabled) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");

  if (panel.dataset.built === String(kinds.length)) return;
  panel.dataset.built = String(kinds.length);
  panel.innerHTML = "";

  for (const a of kinds) {
    const wrap = el("div", "alert-item");
    const btn = el("button", "btn-alert");
    btn.type = "button";
    btn.id = "alertBtn-" + a.key;
    btn.addEventListener("click", () => onAlertClick(a));
    wrap.appendChild(btn);
    const hint = el("span", "alert-hint");
    hint.id = "alertHint-" + a.key;
    wrap.appendChild(hint);
    panel.appendChild(wrap);
  }
}

function renderAlertUi() {
  buildAlertPanel();
  renderQuickSay();
  if (alertTick) { clearInterval(alertTick); alertTick = null; }

  let anyLive = false;
  for (const a of alertKinds()) {
    const btn = $("#alertBtn-" + a.key);
    const hint = $("#alertHint-" + a.key);
    if (!btn) continue;

    const live = liveAlert(a.key);
    if (live) {
      anyLive = true;
      btn.dataset.expires = String(live.expires || 0);
    } else {
      delete btn.dataset.expires;
    }

    // A running marker does NOT lock the button. Treasure can be dug twice in
    // ten minutes, and the second dig still needs announcing — firing again
    // simply posts a fresh marker and pushes it.
    const cooling = (alertCooldown[a.key] || 0) > Date.now();
    btn.disabled = cooling;

    const armed = armedKey === a.key;
    btn.classList.toggle("confirm", armed);
    btn.textContent = armed ? (a.confirmLabel || "Yes — alert everyone")
                            : (a.buttonLabel || a.key);

    if (cooling) {
      hint.textContent = "Just sent — hold on a moment.";
    } else if (armed) {
      hint.textContent = "Tap again to send. Cancels itself in a few seconds.";
    } else if (live) {
      hint.textContent = "";        // filled by the ticker below
    } else {
      hint.textContent = `${a.minutes || 10}-minute marker, notifies everyone.`;
    }
  }

  const anyCooling = alertKinds().some((a) => (alertCooldown[a.key] || 0) > Date.now());
  if (!anyLive && !anyCooling) return;

  const tick = () => {
    let again = false;
    for (const a of alertKinds()) {
      const btn = $("#alertBtn-" + a.key);
      const hint = $("#alertHint-" + a.key);
      if (!btn) continue;

      // A cooldown that just lapsed has to re-enable the button.
      if (btn.disabled && (alertCooldown[a.key] || 0) <= Date.now()) { renderAlertUi(); return; }
      if (btn.disabled || armedKey === a.key) { again = true; continue; }

      if (!btn.dataset.expires) continue;
      const left = Number(btn.dataset.expires) - Date.now();
      if (left <= 0) { loadActive(); return; }
      const m = Math.floor(left / 60000), s2 = Math.floor((left % 60000) / 1000);
      hint.textContent = `Live on the site — ${m}:${String(s2).padStart(2, "0")} left · you can send another`;
      again = true;
    }
    if (!again) { clearInterval(alertTick); alertTick = null; }
  };
  tick();
  alertTick = setInterval(tick, 1000);
}

function disarmAlert() {
  armedKey = "";
  if (armTimer) { clearTimeout(armTimer); armTimer = null; }
  renderAlertUi();
}

async function onAlertClick(a) {
  if (armedKey !== a.key) {
    armedKey = a.key;
    // Disarm on its own. A button left sitting in "confirm" is a trap for the
    // next person who walks past the laptop.
    if (armTimer) clearTimeout(armTimer);
    armTimer = setTimeout(disarmAlert, 6000);
    renderAlertUi();
    return;
  }

  disarmAlert();
  alertCooldown[a.key] = Date.now() + cooldownMs();
  const btn = $("#alertBtn-" + a.key);
  if (btn) btn.disabled = true;
  setStatus($("#alertStatus"), "Posting…", "");

  const minutes = Number(a.minutes) > 0 ? Number(a.minutes) : 10;
  const sentAt = Date.now();
  let recoveredId = "";

  try {
    const res = await postThenVerify({
      action: "callout", secret: state.password, type: a.key,
      message: a.note || "Alert.", minutes,
      author: $("#authorInput") ? $("#authorInput").value.trim() : "",
    }, async () => {
      const json = await apiGet({ action: "data", sheet: SHEET });
      const hit = (json.data || []).find((r) =>
        String(r.Type || "").trim().toLowerCase() === a.key &&
        Date.parse(String(r.Created || "")) >= sentAt - 120000);
      if (hit) recoveredId = String(hit.Id || "").trim();
      return !!hit;
    });

    if (!res.ok) {
      showRefusal($("#alertStatus"), res);
      return;
    }

    // A quick alert ALWAYS notifies — an unannounced marker is pointless.
    setStatus($("#alertStatus"), "Posted. Sending notifications…", "");
    const id = String(res.id || recoveredId || "");
    try {
      const n = await notifyForCallout({ type: a.key, message: a.note || "" }, "", id);
      setStatus($("#alertStatus"),
        n.none ? "Marker is live. No subscribers yet, so nobody was notified."
               : `Marker is live. Notified ${n.sent} of ${n.total} device${n.total === 1 ? "" : "s"}.`,
        "ok");
    } catch (e) {
      setStatus($("#alertStatus"),
        "Marker is live on the site, but the notification failed: " + (e.message || e), "err");
    }
    await loadActive();
  } catch (e) {
    setStatus($("#alertStatus"), "Failed: " + (e.message || e), "err");
  } finally {
    renderAlertUi();
  }
}

/* ------------------------------------------------- quick announce

   Type a line, send it to everyone. The composer is the considered path —
   templates, commanders, badges, a duration, a preview. This is the other
   case: something worth saying right now, where all of that is friction.

   One tap, unlike the bare treasure and gift buttons. Typing the message is
   the deliberation; there is no stray click that produces a sentence.
   ------------------------------------------------------------------ */

let quickSayCooling = 0;

function quickCfg() {
  return CFG.quickAnnounce || {};
}

function renderQuickSay() {
  const row = $("#quickSay");
  if (!row) return;
  const q = quickCfg();
  if (!q.enabled) { row.classList.add("hidden"); return; }
  row.classList.remove("hidden");

  const input = $("#quickSayInput");
  const btn = $("#quickSayBtn");
  const hint = $("#quickSayHint");

  input.placeholder = q.placeholder || "Say something to the whole alliance…";
  input.maxLength = Number(q.maxLength) > 0 ? Number(q.maxLength) : 300;
  btn.textContent = q.buttonLabel || "Announce";

  const cooling = quickSayCooling > Date.now();
  const empty = !input.value.trim();
  btn.disabled = cooling || empty;

  const hours = q.hours || 6;
  const n = state.subCount || 0;

  // Say what this does BEFORE anything is typed. The text is posted publicly on
  // the HQ page, not just pushed to phones, and an admin should know that while
  // they are deciding what to write rather than after they have sent it.
  hint.textContent = cooling
    ? "Just sent — hold on a moment."
    : empty
      ? (q.note || "Posted publicly on the HQ page and sent as a notification.")
      : `Goes on the HQ page for ${hours}h · notifies ${n} device${n === 1 ? "" : "s"}`;
}

async function onQuickSay() {
  const q = quickCfg();
  const input = $("#quickSayInput");
  const message = input.value.trim();
  if (!message) return;

  quickSayCooling = Date.now() + cooldownMs();
  $("#quickSayBtn").disabled = true;
  setStatus($("#alertStatus"), "Posting…", "");

  const hours = Number(q.hours) > 0 ? Number(q.hours) : 6;
  const sentAt = Date.now();
  let recoveredId = "";

  try {
    const res = await postThenVerify({
      action: "callout", secret: state.password, type: "announcement",
      message, hours,
      author: $("#authorInput") ? $("#authorInput").value.trim() : "",
    }, async () => {
      const json = await apiGet({ action: "data", sheet: SHEET });
      const hit = (json.data || []).find((r) =>
        String(r.Message == null ? "" : r.Message).trim() === message &&
        Date.parse(String(r.Created || "")) >= sentAt - 120000);
      if (hit) recoveredId = String(hit.Id || "").trim();
      return !!hit;
    });

    if (!res.ok) {
      showRefusal($("#alertStatus"), res);
      return;
    }

    // Always notifies. A quick announcement nobody is told about may as well
    // not exist — that is the entire difference from the composer.
    setStatus($("#alertStatus"), "Posted. Sending notifications…", "");
    const id = String(res.id || recoveredId || "");
    try {
      const n = await notifyForCallout({ type: "announcement", message, hours }, "", id);
      setStatus($("#alertStatus"),
        n.none ? "Posted. No subscribers yet, so nobody was notified."
               : `Posted. Notified ${n.sent} of ${n.total} device${n.total === 1 ? "" : "s"}.`,
        "ok");
    } catch (e) {
      setStatus($("#alertStatus"),
        "Posted on the site, but the notification failed: " + (e.message || e), "err");
    }

    input.value = "";
    await loadActive();
  } catch (e) {
    setStatus($("#alertStatus"), "Failed: " + (e.message || e), "err");
  } finally {
    renderQuickSay();
    // Re-enable once the cooldown lapses, without a ticker running forever.
    setTimeout(renderQuickSay, cooldownMs() + 200);
  }
}

/**
 * Restate the notify choice on the Post button itself.
 *
 * The checkbox alone was not enough: it sat above the preview, below a roster
 * grid a screen and a half tall, and a real callout went out with nobody
 * notified. The button is the last thing looked at before committing, so it is
 * the right place to say what is about to happen.
 */
function syncPostButton() {
  const cb = $("#notifyCheck");
  const btn = $("#postBtn");
  if (!cb || !btn) return;
  const n = state.subCount || 0;
  btn.textContent = cb.checked && n
    ? `Post + notify ${n} device${n === 1 ? "" : "s"}`
    : "Post callout";
}

/** How many devices would receive a notification right now. */
async function refreshNotifyCount() {
  const label = $("#notifyCount");
  if (!label) return;
  try {
    const res = await pushPost({ action: "push_list", secret: state.password },
                               (r) => typeof r.count === "number");
    // The one call every unlock makes anyway, so it is where a restored-but-
    // stale password surfaces. Silently showing "nobody has subscribed yet"
    // for a session that is not actually authorised would be a lie.
    if (res && res.error === "unauthorized") {
      lockOut("That password is no longer accepted. Please enter it again.");
      return;
    }
    const n = res && res.ok ? res.count : 0;
    state.subCount = n;
    label.textContent = n === 0 ? "— nobody has subscribed yet"
                      : n === 1 ? "— 1 device" : `— ${n} devices`;
    $("#notifyCheck").disabled = n === 0;
    syncPostButton();
  } catch (_) {
    label.textContent = "";     // never let this break the composer
  }
}

/**
 * Encrypt and send one message to every subscriber.
 *
 * Returns { sent, failed, disabled }. Never throws for a partial failure:
 * reaching most of the alliance is the normal good outcome, and the count is
 * reported honestly rather than rounded up to "done".
 */
async function notifySubscribers({ title, body, url, ttl }) {
  const { buildPush, importVapidPrivateKey } = await loadPushCrypto();

  const keyRes = await pushPost({ action: "push_key", secret: state.password, who: "admin" },
                                (r) => !!r.publicKey);
  if (!keyRes.ok) throw new Error(keyRes.error || "could not read the push key");

  const listRes = await pushPost({ action: "push_list", secret: state.password },
                                 (r) => Array.isArray(r.subs));
  if (!listRes.ok) throw new Error(listRes.error || "could not read subscribers");
  if (!listRes.count) return { sent: 0, failed: 0, disabled: 0, none: true };

  const vapid = {
    subject: keyRes.subject,
    publicKey: keyRes.publicKey,
    signingKey: await importVapidPrivateKey(keyRes.publicKey, keyRes.privateKey),
  };
  const payload = JSON.stringify({ title, body, url: url || "./#shoutouts" });

  const items = [];
  for (const sub of listRes.subs) {
    try {
      const built = await buildPush({ subscription: sub, payload, vapid, ttl });
      items.push({ endpoint: built.endpoint, headers: built.headers, bodyB64: built.bodyB64 });
    } catch (e) {
      // One malformed stored subscription must not stop the other 99.
      console.error("Could not build a push for", sub.endpoint, e);
    }
  }

  const results = [];
  for (let i = 0; i < items.length; i += PUSH_BATCH) {
    const batch = items.slice(i, i + PUSH_BATCH);
    const res = await pushPost({ action: "push_relay", secret: state.password, items: batch },
                               (r) => Array.isArray(r.results));
    if (res.ok && res.results) results.push(...res.results);
  }

  // Hand the statuses back so dead subscriptions get retired. Best effort: a
  // failure here costs bookkeeping, not delivery.
  if (results.length) {
    try {
      await pushPost({ action: "push_apply", secret: state.password, results },
                     (r) => typeof r.updated === "number");
    } catch (e) { console.error("Could not record send results:", e); }
  }

  let sent = 0, disabled = 0;
  for (const r of results) {
    if (r.status >= 200 && r.status <= 299) sent++;
    if (r.status === 404 || r.status === 410) disabled++;
  }
  return { sent, failed: results.length - sent, disabled, total: results.length };
}

/**
 * Build the notification text for a callout and send it — at most once.
 *
 * The claim is the whole point. postThenVerify retries a lost POST, which is
 * right for a sheet write and wrong for a push: the notification already
 * reached every phone, and a retry sends it again. push_claim stamps the
 * callout under a script lock, so only the first attempt is allowed to send.
 *
 * `force` bypasses it, and only the human-operated Retry button passes it.
 */
async function notifyForCallout(d, commander, calloutId, force) {
  if (calloutId) {
    // One token per notify attempt. pushPost retries a lost POST, and without
    // this the first attempt stamps the row, loses its response, and the
    // second is told "already sent" — so nothing goes out at all.
    const token = (crypto.randomUUID && crypto.randomUUID()) ||
                  String(Date.now()) + Math.random().toString(36).slice(2);
    const claim = await pushPost(
      { action: "push_claim", secret: state.password, calloutId, token, force: !!force },
      (r) => typeof r.claimed === "boolean");
    if (!claim.ok) throw new Error(claim.error || "could not claim the callout");
    if (!claim.claimed) return { sent: 0, failed: 0, disabled: 0, total: 0, already: true };
  }
  return notifyBody(d, commander);
}

async function notifyBody(d, commander) {
  const isShout = d.type === "shoutout";
  // Tie the push lifetime to the shoutout's own: a rally call has no value six
  // hours later, and a phone that was off all night should not wake to it.
  const hours = Number(d.hours) > 0 ? Number(d.hours) : 24;
  const ttl = Math.min(hours * 3600, 86400);

  const kind = alertFor(d.type);
  if (kind) {
    return notifySubscribers({
      title: kind.pushTitle || kind.buttonLabel || "Alert",
      body: kind.pushBody || d.message,
      url: "./",
      // Outlive the marker by no more than the marker itself: a notification
      // delivered after the thing has closed is worse than none.
      ttl: Math.max(60, Math.round((Number(kind.minutes) || 10) * 60)),
    });
  }

  return notifySubscribers({
    title: isShout ? `Shoutout: ${commander}` : `${CFG.name || "Alliance"} announcement`,
    body: d.message,
    url: "./#shoutouts",
    ttl,
  });
}

/**
 * Re-send the notification for the callout that was just posted.
 *
 * Deliberately does NOT repost the callout — the row is already in the sheet,
 * and a second one would be the worst possible fix for a lost notification.
 */
async function retryNotify() {
  if (!lastNotify) return;
  const btn = $("#retryNotifyBtn");
  btn.disabled = true;
  setStatus($("#postStatus"), "Sending notifications…", "");
  try {
    const n = await notifyForCallout(lastNotify.draft, lastNotify.commander,
                                     lastNotify.calloutId, true);
    setStatus($("#postStatus"),
      n.none ? "No subscribers yet, so nothing was sent."
             : `Notified ${n.sent} of ${n.total} device${n.total === 1 ? "" : "s"}.`,
      n.sent ? "ok" : "err");
    if (n.sent === n.total) btn.classList.add("hidden");
  } catch (e) {
    setStatus($("#postStatus"), "Notification failed again: " + (e.message || e), "err");
  } finally {
    btn.disabled = false;
  }
}

async function postCallout() {
  const d = draft();
  if (!d.message) { setStatus($("#postStatus"), "Write a message first.", "err"); return; }
  if (d.type === "shoutout" && !d.names.length) { setStatus($("#postStatus"), "A shoutout needs at least one commander.", "err"); return; }

  $("#postBtn").disabled = true;
  setStatus($("#postStatus"), "Posting…", "");
  const commander = d.names.join(NAME_SEP);
  const sentAt = Date.now();
  let recoveredId = "";
  try {
    const res = await postThenVerify({
      action: "callout", secret: state.password, type: d.type,
      commander: commander, badge: d.badge,
      message: d.message, hours: d.hours, author: d.author,
    }, async () => {
      const json = await apiGet({ action: "data", sheet: SHEET });
      // Keep the id off the recovered row: without it a lost response leaves
      // nothing to claim, and the dedup gate silently stops applying.
      const hit = (json.data || []).find((r) =>
        String(r.Message == null ? "" : r.Message).trim() === d.message &&
        String(r.Commander == null ? "" : r.Commander).trim() === commander &&
        Date.parse(String(r.Created || "")) >= sentAt - 120000);
      if (hit) recoveredId = String(hit.Id || "").trim();
      return !!hit;
    });
    if (!res.ok) {
      showRefusal($("#postStatus"), res);
      return;
    }
    // The callout is written and verified. Only now does the push go out, and
    // only as a separate step — a push that fails must never call into
    // question a shoutout that is already live on the site.
    let tail = "";
    if ($("#notifyCheck").checked) {
      const calloutId = String(res.id || recoveredId || "");
      lastNotify = { draft: d, commander, calloutId };
      setStatus($("#postStatus"), "Posted. Sending notifications…", "");
      try {
        const n = await notifyForCallout(d, commander, calloutId);
        tail = n.already ? " It had already been notified, so nothing was sent again."
             : n.none ? " No subscribers yet, so nothing was sent."
             : ` Notified ${n.sent} of ${n.total} device${n.total === 1 ? "" : "s"}.` +
               (n.disabled ? ` ${n.disabled} stale subscription${n.disabled === 1 ? "" : "s"} retired.` : "");
        $("#retryNotifyBtn").classList.toggle("hidden", n.sent === n.total || n.none);
      } catch (e) {
        // Say plainly that the post landed and the notification did not,
        // rather than one word that could mean either.
        tail = " But the notification failed: " + (e.message || e);
        $("#retryNotifyBtn").classList.remove("hidden");
      }
    }

    setStatus($("#postStatus"), "Posted. It is live on the site now." + tail,
              tail.indexOf("failed") === -1 ? "ok" : "err");
    state.names = [];
    state.badge = "";
    $("#commanderInput").value = "";
    $("#messageInput").value = "";        // cleared, so syncTemplates re-prefills
    renderCommanderChips();
    renderRosterGrid("");
    renderBadges();
    syncTemplates();
    renderPreview();
    syncPostButton();
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
    const res = await postThenVerify(
      { action: "callout_expire", secret: state.password, id: c.id },
      async () => {
        const json = await apiGet({ action: "data", sheet: SHEET });
        const row = (json.data || []).find((r) => String(r.Id).trim() === c.id);
        const exp = row ? calloutExpiry(row.Expires) : null;
        return exp !== null && exp <= Date.now();
      });
    if (!res.ok) { btn.disabled = false; btn.textContent = "Remove now"; showRefusal($("#postStatus"), res); return; }
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

  // The button reads its state from these rows, so it has to re-render
  // whenever they change — including when an alert expires on its own.
  renderAlertUi();
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
  $("#lockBtn").addEventListener("click", () => lockOut("Locked. Enter the password to get back in."));
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
  $("#retryNotifyBtn").addEventListener("click", retryNotify);
  $("#notifyCheck").addEventListener("change", syncPostButton);
  $("#quickSayBtn").addEventListener("click", onQuickSay);
  $("#quickSayInput").addEventListener("input", renderQuickSay);
  $("#quickSayInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("#quickSayBtn").disabled) onQuickSay();
  });
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

  // Already unlocked on this browser, in any tab and across restarts — go
  // straight in. enterAdmin's own push_list call locks the page back up if the
  // stored password has stopped working.
  const saved = loadPw();
  if (saved) { state.password = saved; enterAdmin(); }
}

boot();
