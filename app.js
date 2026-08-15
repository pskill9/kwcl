/* ============================================================
   kWcl — Korea World Class · Alliance HQ
   Static client for the Google Apps Script snapshot API.
   ============================================================ */

"use strict";

/* ------------------------------------------------------------
   CONFIG — alliance identity lives in config.js (edit that file,
   not this one). CFG falls back to a bare default so the page
   still renders if config.js is missing.                       */
const CFG = Object.assign(
  { name: "Alliance", fullName: "", localName: "", game: "Last War: Survival",
    apiUrl: "", icon: null, theme: null, charter: null, footerMotto: "", strings: {} },
  window.ALLIANCE_CONFIG || {}
);

/* Built-in English labels. config.js strings override any of these —
   as "Plain text" or as { local: "현지어", en: "English" }. */
const STR_EN = {
  situationBoard: "Situation board",
  heroTitle: "Alliance Headquarters",
  allianceChart: "Alliance total power",
  statTotalPower: "Total power",
  statGrowth7d: "7-day growth",
  statCommanders: "Commanders",
  statAvgPower: "Avg power",
  charter: "Alliance charter",
  shoutouts: "Shoutouts",
  shoutoutFlag: "Shoutout",
  announcementFlag: "Announcement",
  newcomers: "New arrivals",
  welcomeNote: "Joined today — say hello.",
  welcomeFlag: "New",
  hallOfFame: "Hall of fame",
  hofEvent: "Event",
  hofLatest: "Latest",
  movers: "Movers",
  topGainers: "Top gainers",
  declining: "Declining",
  roster: "Roster",
  dossier: "Commander dossier",
  powerOverTime: "Power over time",
  rankOverTime: "Rank over time (1 = top)",
  compare: "Compare commanders",
  tiers: "Tier breakdown",
  thRank: "Rank", thCommander: "Commander", thTier: "Tier", thPower: "Power",
  th24h: "Δ 24h", th7d: "Δ 7d", thTrend: "Trend",
  thMembers: "Members", thTotalPower: "Total power", thAvgPower: "Avg power", thShare: "Share",
  searchPlaceholder: "Search commander…",
  addCommander: "Add commander (max 6)…",
  addBtn: "Add",
  rosterHint: "Click any commander for their dossier. Click a column header to sort.",
  modePower: "Power", modeIndexed: "Indexed %",
  compareHintPower: "Absolute power. Switch to Indexed % to compare growth rates fairly.",
  compareHintIndexed: "Indexed: growth since each commander's first snapshot — fair comparison across different power levels.",
  noGains: "No gains in this window yet.",
  noDeclines: "Nobody declined — clean sheet.",
  needTwo: "Need at least two daily snapshots to draw a trend — check back tomorrow.",
  factRank: "Current rank", factBestRank: "Best rank", factPower: "Power",
  factGrowth7d: "7-day growth", factTotalGrowth: "Total growth", factAvgDay: "Avg / day",
  factFirstSeen: "First seen", factSnapshots: "Snapshots",
};

/* STR(key) → English string (for plain-text spots).
   STRPAIR(key) → { local?, en } (for two-part headings). */
function STRPAIR(key) {
  const v = CFG.strings[key];
  if (v == null) return { en: STR_EN[key] || key };
  if (typeof v === "string") return { en: v };
  return { local: v.local, en: v.en || STR_EN[key] || key };
}
function STR(key) {
  const p = STRPAIR(key);
  return p.local ? p.local + " · " + p.en : p.en;
}
/* Fill a section-title / panel h2: "현지어 · <span>English</span>" or plain English.
   Tolerates a missing node: index.html and app.js are cached independently (10
   minutes each on GitHub Pages), so a visitor can briefly run new JS against
   old markup. That should cost them one section, not the whole page. */
function setTitle(node, key) {
  if (!node) return;
  const p = STRPAIR(key);
  node.innerHTML = "";
  if (p.local) {
    node.appendChild(document.createTextNode(p.local + " · "));
    const sp = document.createElement("span");
    sp.textContent = p.en;
    node.appendChild(sp);
  } else {
    node.textContent = p.en;
  }
}

const MAX_SNAPSHOTS = 120;   // most recent daily sheets to load
const FETCH_CONCURRENCY = 6;
// Bump this whenever past snapshots are edited in the sheet (e.g. commander
// names corrected). Historical days are served from cache and never refetched,
// so a new key is what forces every visitor to pick the corrections up.
// v4 stores { days: { sheetName: {date, rows} }, hof: [...] }. v2 held rows
// only, with dates supplied by the ?action=sheets response — which is exactly
// what the first paint must not wait for, hence the date living in the cache.
// v4: 멍뭉뇽냥 and 비닐봉달 were renamed to 멍냥Nyang and VINYLBONGㅈ across
// every past day, so every cached snapshot holds the superseded names.
// v5: same again — M A H A was renamed to COLLIE across the Roster and all 19
// past days on 2026-08-11. Past days are never refetched, so without this bump
// a returning browser keeps the old name and COLLIE's trend line starts today.
// v7: 룜 renamed to 됨 on 2026-08-14 — rewritten across the Roster and every
// past day that held them, so a cached v6 would show a join-plus-leave.
const CACHE_KEY = "kwcl_cache_v7";
const CACHE_KEY_PREV = "kwcl_cache_v6";
const API_KEY = "kwcl_api_url";
const COMPARE_MAX = 6;

const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const INK = { primary: "#ffffff", secondary: "#c3c2b7", mute: "#898781", grid: "#2c2c2a", baseline: "#383835" };

/* ------------------------------------------------------------ state */
const state = {
  source: "demo",            // "demo" | "live"
  dates: [],                 // ["2026-06-25", ...] ascending
  snapshots: [],             // [{date, rows}]
  members: new Map(),        // name -> member record
  alliance: [],              // per-date {total, count}
  compare: [],               // selected names
  compareMode: "power",      // "power" | "indexed"
  allianceRange: "ALL",
  projectDays: 0,        // 0 = projection off
  moversRange: "7D",
  rosterSort: { key: "rank", dir: "asc" },
  dossierName: null,
};

/* ------------------------------------------------------------ utils */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function fmtPower(n) {
  if (n == null || isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return Math.round(n / 1e3) + "K";
  return String(Math.round(n));
}
function fmtSigned(n) {
  if (n == null || isNaN(n)) return "—";
  return (n > 0 ? "+" : n < 0 ? "−" : "") + fmtPower(Math.abs(n));
}
function fmtPct(n) {
  if (n == null || !isFinite(n)) return "—";
  return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n * 100).toFixed(1) + "%";
}
function fmtDate(d) { return d ? d.slice(5) : "—"; }         // MM-DD
function deltaClass(n) { return n > 0 ? "up" : n < 0 ? "down" : "flat"; }

function daysBetween(a, b) { // date strings YYYY-MM-DD
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * mag);
  const step = candidates.find((s) => span / s <= count + 0.5) || candidates[4];
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/* ------------------------------------------------------------ API */
function getApiUrl() {
  const p = new URLSearchParams(location.search).get("api");
  if (p) { try { localStorage.setItem(API_KEY, p); } catch (_) {} return p; }
  try { return localStorage.getItem(API_KEY) || CFG.apiUrl; } catch (_) { return CFG.apiUrl; }
}

async function fetchJson(url, timeoutMs = 30000, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // credentials:"omit" matters — with Google cookies attached the Apps
      // Script redirect can land on an account interstitial and answer 404
      // with HTML, so every signed-in visitor silently fell back to cache.
      const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", credentials: "omit" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      // Apps Script occasionally hangs on cold starts — retry once
      if (attempt >= retries) throw e;
    } finally { clearTimeout(t); }
  }
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (raw && raw.days) {
      return {
        days: raw.days, hof: raw.hof || null, shoutouts: raw.shoutouts || null,
        fullAt: Number(raw.fullAt) || 0,
      };
    }
  } catch (_) { /* unparseable — treat as empty */ }
  return { days: {}, hof: null, shoutouts: null, fullAt: 0 };
}

/* The snapshot, hall-of-fame and shoutout loaders run concurrently and all
   persist, so each writes only its own slice and carries the others over
   untouched. */
function saveCache(part) {
  try {
    const cur = readCache();
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      days: part.days || cur.days,
      hof: part.hof === undefined ? cur.hof : part.hof,
      shoutouts: part.shoutouts === undefined ? cur.shoutouts : part.shoutouts,
      fullAt: part.fullAt === undefined ? cur.fullAt : part.fullAt,
    }));
    localStorage.removeItem(CACHE_KEY_PREV);   // dead weight once v7 is written
  } catch (_) { /* storage full — skip caching */ }
}

/* One request for every day, columnar so commander names aren't repeated once
   per day. Returns null when the deployed script predates ?action=all — an old
   deployment ignores the unknown action and answers with a single sheet's
   rows, so the shape is what we check, not the HTTP status. */
async function loadBulk(base, since) {
  const url = base + "?action=all&limit=" + MAX_SNAPSHOTS + (since ? "&since=" + since : "");
  /* Three retries rather than the default one. Apps Script intermittently
     answers with 404/HTML, and a cold start can outrun the 30s timeout — both
     transient and independent between attempts, so a later try usually lands
     (and the cold call warms the script for the next one). Giving up here
     drops a first-time visitor, who has no cache to fall back on, all the way
     to demo numbers. */
  const json = await fetchJson(url, 30000, 3);
  return json && Array.isArray(json.dates) && Array.isArray(json.members) ? json : null;
}

function snapshotsFromBulk(bulk) {
  return bulk.dates.map((date, di) => ({
    date,
    rows: bulk.members
      .filter((m) => m.power && m.power[di] != null)
      .map((m) => ({
        rank: Number(m.rank && m.rank[di]),
        name: String(m.name || "").trim(),
        tier: String(m.tier || "").trim().toUpperCase(),
        power: Number(m.power[di]),
      }))
      .filter((r) => r.name && isFinite(r.power)),
  }));
}

/* How long the incremental path is trusted before a full re-read. */
const FULL_REFRESH_MS = 24 * 3600 * 1000;

async function loadLive(base) {
  // Fast path: ask only for days newer than what's already cached, in one call.
  const cache = readCache();
  const byDate = {};
  for (const d of Object.values(cache.days)) if (d && d.date && Array.isArray(d.rows)) byDate[d.date] = d;
  const newest = Object.keys(byDate).sort().pop() || null;

  /* `since` is derived from the NEWEST cached day, which quietly assumes the
     cache is complete for everything older. It is not always: a first load
     that partly failed leaves a cache short at the OLD end, and from then on
     every visit asks only for days after the newest one — so the missing
     history is never requested again and the chart stays truncated forever.
     Seen in the wild: a cache holding 6 days while the sheet had 15.

     So the incremental path is trusted for a day at a time, and once a day the
     whole range is re-read. That is one full call per visitor per day, which
     is what a first-time visitor pays anyway, and it makes a damaged cache
     repair itself instead of needing the visitor to know to clear it. */
  const stale = !cache.fullAt || (Date.now() - cache.fullAt) > FULL_REFRESH_MS;
  const since = stale ? null : newest;

  const bulk = await loadBulk(base, since);
  if (bulk) {
    // `since` is inclusive, so the newest cached day comes back refreshed
    for (const s of snapshotsFromBulk(bulk)) byDate[s.date] = { date: s.date, rows: s.rows };
    const all = Object.keys(byDate).sort().slice(-MAX_SNAPSHOTS).map((d) => byDate[d]);
    const days = {};
    for (const d of all) days[d.date] = d;
    saveCache(stale ? { days, fullAt: Date.now() } : { days });
    return all.map((d) => ({ date: d.date, rows: d.rows }));
  }

  return loadPerSheet(base);
}

/* Legacy path for deployments without ?action=all: list the tabs, then fetch
   each uncached day separately. */
async function loadPerSheet(base) {
  const meta = await fetchJson(base + "?action=sheets");
  const sheets = (meta.sheets || [])
    .filter((s) => s.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-MAX_SNAPSHOTS);
  if (!sheets.length) throw new Error("The API returned no dated sheets.");

  const cache = readCache();
  const latestName = sheets[sheets.length - 1].name;

  const snapshots = await pool(sheets, FETCH_CONCURRENCY, async (s) => {
    // historical sheets are immutable — only the latest is refetched
    const hit = cache.days[s.name];
    if (s.name !== latestName && hit) return { date: hit.date || s.date, rows: hit.rows };
    const json = await fetchJson(base + "?action=data&sheet=" + encodeURIComponent(s.name));
    const rows = (json.data || []).map((r) => ({
      rank: Number(r.Rank), name: String(r.Commander || "").trim(),
      tier: String(r.Tier || "").trim().toUpperCase(), power: Number(r.Power),
    })).filter((r) => r.name && isFinite(r.power));
    cache.days[s.name] = { date: s.date, rows };
    return { date: s.date, rows };
  });

  const days = {};
  for (const s of sheets) if (cache.days[s.name]) days[s.name] = cache.days[s.name];
  saveCache({ days });
  return snapshots;
}

/* ------------------------------------------------------------ hall of fame
   A hand-kept sheet tab of past event winners: Event, Week, Commander. It has
   no date in its name, so the snapshot loader already skips it — this fetches
   it explicitly. Missing tab, empty tab or a fork that never made one all end
   the same way: the section stays hidden. */
const HOF = [];

/* A Week cell left formatted as a date (rather than plain text) comes back as
   an ISO datetime — "2026-07-05T07:00:00.000Z" — which would display raw and
   sort against the plain ones. Midnight in the sheet's timezone lands before
   noon UTC for western offsets and after noon for eastern ones, so the hour
   tells us which calendar day was meant. */
function normWeek(v) {
  const s = String(v == null ? "" : v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/);
  if (!m) return s;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (+m[4] >= 12) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function loadHallOfFame(base) {
  const sheet = CFG.hallOfFameSheet || "Hall of Fame";
  try {
    const json = await fetchJson(base + "?action=data&sheet=" + encodeURIComponent(sheet), 20000, 0);
    const rows = (json.data || []).map((r) => ({
      event: String(r.Event == null ? "" : r.Event).trim(),
      week: normWeek(r.Week),
      name: String(r.Commander == null ? "" : r.Commander).trim(),
    })).filter((r) => r.name);
    // newest first: week descends, then event, so a week with two entries still orders
    rows.sort((a, b) => b.week.localeCompare(a.week) || (Number(b.event) || 0) - (Number(a.event) || 0));
    HOF.length = 0;
    HOF.push(...rows);
    saveCache({ hof: rows });
  } catch (_) { /* no sheet, no section — whatever came from cache stands */ }
}

/* ------------------------------------------------------------ shoutouts
   A hand-posted tab of short, time-limited messages: Id, Type, Commander,
   Message, Created, Expires, Author. Written by admin.html through the
   password-guarded callout endpoint; read here through the same plain
   ?action=data path the hall of fame uses. No tab, no section. */
const SHOUTOUTS = [];

/* Sheets can hand back a Date object, an ISO string, or "" for a blank cell.
   Anything that fails to parse is treated as ALREADY EXPIRED rather than
   never-expiring: a malformed row should disappear on its own, not stick to
   the front page forever with no way to clear it from the UI. */
function calloutExpiry(v) {
  if (v === null || v === undefined) return null;          // blank => until removed
  const s = String(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;                                 // 0 => epoch => expired
}

function calloutActive(c, now) {
  return c.expires === null || c.expires > now;
}

/* A shoutout can cover several people, stored as "a, b, c". No commander name
   on record contains a comma, so splitting on it is safe and the cell stays
   readable to anyone opening the sheet. */
function splitNames(v) {
  return String(v == null ? "" : v).split(",").map((s) => s.trim()).filter(Boolean);
}

function calloutBadge(key) {
  const list = (CFG.callouts && CFG.callouts.badges) || [];
  return list.find((b) => b.key === String(key || "").trim()) || null;
}

/* Rows cached by an earlier build carry a single `name` string instead of the
   `names` array, and no badge. paintFromCache restores them before any network
   call, so without this an old cache throws inside the first render — and
   because that render is not guarded, it takes the whole boot down rather than
   just this section. */
function migrateCallout(c) {
  if (c && Array.isArray(c.names)) return c;
  const name = c && c.name ? String(c.name).trim() : "";
  return Object.assign({}, c, { names: name ? [name] : [], badge: (c && c.badge) || "" });
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

async function loadShoutouts(base) {
  const sheet = (CFG.callouts && CFG.callouts.sheet) || "Shoutouts";
  try {
    const json = await fetchJson(base + "?action=data&sheet=" + encodeURIComponent(sheet), 20000, 0);
    const rows = (json.data || []).map((r) => ({
      id: String(r.Id == null ? "" : r.Id).trim(),
      type: calloutType(r.Type),
      names: splitNames(r.Commander),
      badge: String(r.Badge == null ? "" : r.Badge).trim(),
      message: String(r.Message == null ? "" : r.Message).trim(),
      created: String(r.Created == null ? "" : r.Created).trim(),
      expires: calloutExpiry(r.Expires),
      author: String(r.Author == null ? "" : r.Author).trim(),
    })).filter((r) => r.message);
    // newest first, so the freshest callout leads
    rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    SHOUTOUTS.length = 0;
    SHOUTOUTS.push(...rows);
    saveCache({ shoutouts: rows });
  } catch (_) { /* no tab, no section — whatever came from cache stands */ }
}

function renderShoutouts() {
  const section = $("#shoutouts");
  const list = $("#shoutoutList");
  if (!section || !list) return;

  // Filtering at render (not at load) is what makes a cached-but-since-expired
  // callout vanish on a return visit instead of flashing before the network
  // answers.
  const now = Date.now();
  // A one-tap alert is not a card. It has its own marker above the fold, and
  // a duplicate down in the list would add noise to something that is only
  // live for ten minutes.
  const active = SHOUTOUTS.map(migrateCallout)
    .filter((c) => calloutActive(c, now) && !alertFor(c.type));

  list.innerHTML = "";
  if (!active.length) { section.classList.add("hidden"); return; }

  setTitle($("#shoutoutsTitle"), "shoutouts");

  for (const c of active) {
    const card = el("div", "callout callout-" + c.type);

    if (c.type === "shoutout" && c.names.length) {
      const stack = el("div", "callout-faces");
      for (const n of c.names.slice(0, 6)) stack.appendChild(avatarEl(n, 46));
      card.appendChild(stack);
    } else {
      card.appendChild(el("div", "callout-icon", "!"));
    }

    const body = el("div", "callout-body");
    const head = el("div", "callout-head");
    head.appendChild(el("span", "callout-flag",
      STR(c.type === "shoutout" ? "shoutoutFlag" : "announcementFlag")));
    if (c.type === "shoutout" && c.names.length) {
      head.appendChild(el("span", "callout-name", c.names.join(", ")));
    }
    const badge = calloutBadge(c.badge);
    if (badge) {
      const chip = el("span", "callout-badge");
      chip.appendChild(el("span", "callout-badge-icon", badge.icon));
      chip.appendChild(document.createTextNode(badge.label));
      head.appendChild(chip);
    }
    body.appendChild(head);

    // Admins type multi-line messages; keep the line breaks without ever
    // putting sheet text through innerHTML.
    const msg = el("p", "callout-msg");
    msg.textContent = c.message;
    body.appendChild(msg);

    const meta = [];
    if (c.author) meta.push(c.author);
    if (c.expires !== null) meta.push(untilLabel(c.expires - now));
    if (meta.length) body.appendChild(el("div", "callout-meta", meta.join(" · ")));

    card.appendChild(body);
    list.appendChild(card);
  }
  section.classList.remove("hidden");
}

/** "3d left" / "5h left" / "12m left" — coarse on purpose, no ticking clock. */
function untilLabel(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins >= 1440) return Math.round(mins / 1440) + "d left";
  if (mins >= 60) return Math.round(mins / 60) + "h left";
  return mins + "m left";
}

/* ------------------------------------------------------------ demo data */
function demoSnapshots() {
  let seed = 20260724;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const roster = [
    ["칸의후예", "R5"], ["포켓캣 cat", "R4"], ["서울의달", "R4"], ["BlackTiger", "R4"],
    ["불사조", "R4"], ["무적함대", "R4"], ["김치전사", "R3"], ["한강라이더", "R3"],
    ["달빛검객", "R3"], ["붉은늑대", "R3"], ["GangnamGhost", "R3"], ["천하무적", "R3"],
    ["IceBear곰", "R3"], ["서리한", "R3"], ["PhoenixPark", "R3"], ["혜성", "R3"],
    ["람보르기니", "R3"], ["백호", "R3"], ["JinRoh", "R2"], ["몬스터헌터", "R2"],
    ["빙하기", "R2"], ["CaptainChoi", "R2"], ["은하수", "R2"], ["돌격대장", "R2"],
    ["LeeSinPro", "R2"], ["타이푼", "R2"], ["GoldDragon금", "R2"], ["설악산", "R2"],
    ["MinjunX", "R2"], ["코브라", "R1"], ["HanSolo한", "R1"], ["번개", "R1"],
    ["StormRider", "R1"], ["야수", "R1"], ["VortexV", "R1"], ["Nova킴", "R1"],
    ["밤의제왕", "R1"], ["SeoulSlayer", "R1"], ["TTaeGGal", "R1"], ["ZeroCool", "R1"],
  ];

  const DAYS = 35;
  const end = new Date();
  const dates = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(end); d.setDate(end.getDate() - (DAYS - 1 - i));
    return d.toISOString().slice(0, 10);
  });

  const members = roster.map(([name, tier], i) => {
    const base = 118e6 * Math.pow(0.94, i) * (0.85 + rand() * 0.3);
    const growth = 0.002 + rand() * 0.011;           // 0.2–1.3% daily
    const joinsAt = i >= 37 ? Math.floor(DAYS * 0.4 + rand() * DAYS * 0.3) : 0;
    const leavesAt = i === 33 ? Math.floor(DAYS * 0.75) : DAYS;
    return { name, tier, base, growth, joinsAt, leavesAt, jumpDay: rand() < 0.35 ? Math.floor(rand() * DAYS) : -1 };
  });

  return dates.map((date, d) => {
    const rows = [];
    for (const m of members) {
      if (d < m.joinsAt || d >= m.leavesAt) continue;
      let p = m.base * Math.pow(1 + m.growth, d) * (1 + (rand() - 0.5) * 0.004);
      if (m.jumpDay >= 0 && d >= m.jumpDay) p *= 1.06;
      rows.push({ name: m.name, tier: m.tier, power: Math.round(p) });
    }
    rows.sort((a, b) => b.power - a.power);
    return { date, rows: rows.map((r, i) => ({ rank: i + 1, ...r })) };
  });
}

/* ------------------------------------------------------------ model */
function buildModel(snapshots) {
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  const dates = snapshots.map((s) => s.date);
  const members = new Map();

  snapshots.forEach((snap, di) => {
    for (const r of snap.rows) {
      let m = members.get(r.name);
      if (!m) {
        m = { name: r.name, tier: r.tier, power: new Array(dates.length).fill(null), rank: new Array(dates.length).fill(null) };
        members.set(r.name, m);
      }
      m.power[di] = r.power;
      m.rank[di] = r.rank;
      m.tier = r.tier || m.tier;
    }
  });

  for (const m of members.values()) {
    let last = null, first = null;
    for (let i = 0; i < dates.length; i++) {
      if (m.power[i] != null) { if (first === null) first = i; last = i; }
    }
    m.firstIdx = first; m.lastIdx = last;
    m.active = last === dates.length - 1;
    m.latestPower = m.power[last];
    m.latestRank = m.rank[last];
    m.bestRank = Math.min(...m.rank.filter((r) => r != null));
  }

  const alliance = dates.map((_, di) => {
    let total = 0, count = 0;
    for (const m of members.values()) if (m.power[di] != null) { total += m.power[di]; count++; }
    return { total, count };
  });

  state.dates = dates;
  state.snapshots = snapshots;
  state.members = members;
  state.alliance = alliance;
}

/* series value at (or nearest before) `days` ago from the last snapshot */
function idxDaysAgo(days) {
  const dates = state.dates;
  const lastDate = dates[dates.length - 1];
  if (days === Infinity) return 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (daysBetween(dates[i], lastDate) >= days) return i;
  }
  return 0;
}
function seriesDelta(values, fromIdx) {
  const lastIdx = values.length - 1;
  if (values[lastIdx] == null) return null;
  let i = fromIdx;
  while (i >= 0 && values[i] == null) i--;           // nearest earlier value
  if (i < 0 || i === lastIdx) {
    // fall forward to first value inside the window
    i = fromIdx;
    while (i < lastIdx && values[i] == null) i++;
    if (i >= lastIdx) return null;
  }
  return { abs: values[lastIdx] - values[i], pct: values[i] ? (values[lastIdx] - values[i]) / values[i] : null, fromDate: state.dates[i] };
}

const WINDOWS = { "1D": 1, "7D": 7, "30D": 30, "ALL": Infinity };

/* ------------------------------------------------------------ avatars
   Commander portraits cropped from the in-game ranking live in
   assets/commanders/, keyed by name in index.json. Anyone missing — a joiner
   who arrived since the last crop run, or an alliance that never ran it —
   gets an identity plate generated here instead of a blank square. It is
   drawn rather than fetched so a new name works the moment it appears in the
   data, and so the browser's own text shaping handles Korean, Arabic and
   decorated Latin, which a server-side renderer gets wrong. */
const AVATARS = {};

async function loadAvatarIndex() {
  try {
    const res = await fetch("assets/commanders/index.json", { cache: "no-cache" });
    if (res.ok) Object.assign(AVATARS, await res.json());
  } catch (_) { /* no index — everyone gets a generated plate */ }
}

/* First glyph(s) of a name: two for Latin/digits, one for scripts whose
   glyphs are wide (Korean, CJK, Arabic). Skips leading punctuation and
   splits by grapheme so a decorated character is never cut in half. */
function monogram(name) {
  const chars = typeof Intl !== "undefined" && Intl.Segmenter
    ? [...new Intl.Segmenter().segment(name)].map((s) => s.segment)
    : Array.from(name);
  const letters = chars.filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (!letters.length) return CFG.name.slice(0, 2).toUpperCase();
  // Latin covers ı, ö, Â etc. — narrow glyphs, so two of them read better than one
  const narrow = (c) => /[\p{Script=Latin}\p{Nd}]/u.test(c);
  const first = letters[0];
  if (narrow(first)) {
    const second = letters[1] && narrow(letters[1]) ? letters[1] : "";
    return (first + second).toLocaleUpperCase();
  }
  return first;
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* Generated identity plate: stencilled monogram, alliance tag, a deterministic
   accent so a commander keeps the same colour everywhere on the page. */
function avatarPlate(name, size) {
  const NS = "http://www.w3.org/2000/svg";
  const accent = SERIES[hashCode(name) % SERIES.length];
  const uid = "pl" + hashCode(name).toString(36);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 96 96");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "avatar avatar-plate");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", name);
  const S = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(n);
    return n;
  };

  const defs = S("defs", {});
  const grad = S("radialGradient", { id: uid, cx: "50%", cy: "38%", r: "70%" }, defs);
  S("stop", { offset: "0%", "stop-color": accent, "stop-opacity": 0.30 }, grad);
  S("stop", { offset: "100%", "stop-color": accent, "stop-opacity": 0.04 }, grad);

  // below ~44px the alliance tag is unreadable and just reads as mud, so the
  // small plate drops it and gives the whole tile to the monogram
  const tagged = size >= 44;

  S("rect", { x: 0, y: 0, width: 96, height: 96, fill: "#191917" });
  S("rect", { x: 0, y: 0, width: 96, height: 96, fill: `url(#${uid})` });
  // stencilled corner cut, like a stamped crate marking
  S("path", { d: "M96 0 L96 22 L74 0 Z", fill: accent, opacity: 0.85 });
  if (tagged) {
    S("rect", { x: 0, y: 76, width: 96, height: 20, fill: "#000", opacity: 0.45 });
    S("rect", { x: 0, y: 75.5, width: 96, height: 1, fill: accent, opacity: 0.7 });
  }

  const mono = S("text", {
    x: 48, y: tagged ? 44 : 50, "text-anchor": "middle", "dominant-baseline": "central",
    fill: "#f4f3ec", "font-family": "Rajdhani, 'Noto Sans KR', sans-serif",
    "font-weight": 700, "font-size": tagged ? 40 : 50, "letter-spacing": -1,
  });
  mono.textContent = monogram(name);

  if (tagged) {
    const tag = S("text", {
      x: 48, y: 87, "text-anchor": "middle", "dominant-baseline": "central",
      fill: accent, "font-family": "Rajdhani, sans-serif",
      "font-weight": 700, "font-size": 11, "letter-spacing": 2.5,
    });
    tag.textContent = CFG.name.toUpperCase();
  }

  S("rect", { x: 0.5, y: 0.5, width: 95, height: 95, fill: "none",
              stroke: accent, "stroke-opacity": 0.35, "stroke-width": 1 });
  return svg;
}

function avatarEl(name, size) {
  const src = AVATARS[name];
  if (!src) return avatarPlate(name, size);
  const img = el("img", "avatar");
  img.src = src;
  img.width = size; img.height = size;
  img.loading = "lazy";
  img.alt = name;
  // a path in the index with no file behind it falls back rather than 404-ing visibly
  img.addEventListener("error", () => img.replaceWith(avatarPlate(name, size)), { once: true });
  return img;
}

/* ------------------------------------------------------------ SVG line chart */
const tip = () => $("#chartTip");

function lineChart(container, opts) {
  const {
    dates, series, height = 260, yFmt = fmtPower,
    invert = false, area = false, startIdx = 0, integerTicks = false,
    projection = null,
  } = opts;
  container.innerHTML = "";

  const hist = dates.slice(startIdx);
  const sr = series.map((s) => ({ ...s, values: s.values.slice(startIdx) }));
  // The projection shares one x axis with the history, so future dates are
  // appended here and the split index remembered for everything that has to
  // treat the two halves differently.
  const proj = projection && projection.dates && projection.dates.length ? projection : null;
  const ds = proj ? hist.concat(proj.dates) : hist;
  const splitIdx = hist.length - 1;
  if (hist.length < 2) {
    container.appendChild(el("div", "chart-empty", STR("needTwo")));
    return;
  }

  const W = 900, H = height, PAD = { t: 14, r: 74, b: 26, l: 52 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;

  let mn = Infinity, mx = -Infinity;
  for (const s of sr) for (const v of s.values) if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  if (proj) {
    for (const v of proj.lo) if (v != null) mn = Math.min(mn, v);
    for (const v of proj.hi) if (v != null) mx = Math.max(mx, v);
  }
  if (!isFinite(mn)) { container.appendChild(el("div", "chart-empty", "No data in this range.")); return; }
  const padV = (mx - mn) * 0.08 || mx * 0.05 || 1;
  mn -= padV; mx += padV;
  if (integerTicks) { mn = Math.max(invert ? 1 : 0, Math.floor(mn)); mx = Math.ceil(mx); }

  const x = (i) => PAD.l + (i / (ds.length - 1)) * iw;
  const y = (v) => invert
    ? PAD.t + ((v - mn) / (mx - mn)) * ih
    : PAD.t + ih - ((v - mn) / (mx - mn)) * ih;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  const S = (tag, attrs) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    svg.appendChild(n); return n;
  };

  // gridlines + y labels
  let ticks = niceTicks(mn, mx, 4);
  if (integerTicks) ticks = [...new Set(ticks.map(Math.round))];
  for (const tv of ticks) {
    S("line", { x1: PAD.l, x2: PAD.l + iw, y1: y(tv), y2: y(tv), stroke: INK.grid, "stroke-width": 1 });
    const lbl = S("text", { x: PAD.l - 8, y: y(tv) + 4, "text-anchor": "end", fill: INK.mute, "font-size": 11.5, "font-family": "Rajdhani, sans-serif", "font-weight": 600 });
    lbl.textContent = yFmt(tv);
  }
  // x labels (~6)
  const step = Math.max(1, Math.round(ds.length / 6));
  for (let i = 0; i < ds.length; i += step) {
    const lbl = S("text", { x: x(i), y: H - 8, "text-anchor": "middle", fill: INK.mute, "font-size": 11.5, "font-family": "Rajdhani, sans-serif", "font-weight": 600 });
    lbl.textContent = fmtDate(ds[i]);
  }
  S("line", { x1: PAD.l, x2: PAD.l + iw, y1: PAD.t + ih, y2: PAD.t + ih, stroke: INK.baseline, "stroke-width": 1 });

  // Projection sits UNDER the real series: history is the fact, this is the
  // inference, and the drawing order should say so.
  if (proj) {
    const pts = proj.values.map((v, k) => [x(splitIdx + 1 + k), y(v)]);
    const loPts = proj.lo.map((v, k) => [x(splitIdx + 1 + k), y(v)]);
    const hiPts = proj.hi.map((v, k) => [x(splitIdx + 1 + k), y(v)]);

    // Anchor everything at the last real reading so the band opens from a
    // point rather than appearing out of nowhere a day later.
    const lastV = sr[0].values[sr[0].values.length - 1];
    const anchor = [x(splitIdx), y(lastV)];

    const bandD =
      "M" + [anchor, ...hiPts].map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") +
      "L" + [...loPts].reverse().map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") +
      "Z";
    S("path", { d: bandD, fill: SERIES[0], opacity: 0.10 });

    S("path", {
      d: "M" + [anchor, ...pts].map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L"),
      fill: "none", stroke: SERIES[0], "stroke-width": 2,
      "stroke-dasharray": "5 4", opacity: 0.85,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    });

    // Where measurement stops and arithmetic starts.
    S("line", {
      x1: x(splitIdx), x2: x(splitIdx), y1: PAD.t, y2: PAD.t + ih,
      stroke: INK.mute, "stroke-width": 1, "stroke-dasharray": "2 4", opacity: 0.7,
    });
    const now = S("text", {
      x: x(splitIdx) - 6, y: PAD.t + 11, "text-anchor": "end",
      fill: INK.mute, "font-size": 10.5, "font-family": "Rajdhani, sans-serif",
      "font-weight": 700, "letter-spacing": "1",
    });
    now.textContent = "NOW";
  }

  // series paths (gaps preserved)
  sr.forEach((s) => {
    let d = "", areaD = "", open = false, segStart = null;
    s.values.forEach((v, i) => {
      if (v == null) { open = false; return; }
      if (!open) { d += `M${x(i).toFixed(1)},${y(v).toFixed(1)}`; open = true; segStart = i; }
      else d += `L${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    if (area && sr.length === 1) {
      // simple area under first contiguous run
      const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
      if (pts.length > 1) {
        areaD = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") +
          `L${pts[pts.length - 1][0].toFixed(1)},${PAD.t + ih}L${pts[0][0].toFixed(1)},${PAD.t + ih}Z`;
        S("path", { d: areaD, fill: s.color, opacity: 0.10 });
      }
    }
    S("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });

    // direct end label (≤4 series)
    if (sr.length <= 4 && s.values[s.values.length - 1] != null && s.endLabel !== false) {
      const ly = y(s.values[s.values.length - 1]);
      const lbl = S("text", { x: PAD.l + iw + 6, y: ly + 4, fill: s.color, "font-size": 12, "font-family": "Rajdhani, sans-serif", "font-weight": 700 });
      lbl.textContent = s.shortName || s.name;
    }
  });

  // hover layer
  const cross = S("line", { x1: 0, x2: 0, y1: PAD.t, y2: PAD.t + ih, stroke: INK.mute, "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0 });
  const dots = sr.map((s) => S("circle", { r: 4, fill: s.color, stroke: "#1a1a19", "stroke-width": 2, opacity: 0 }));
  const overlay = S("rect", { x: PAD.l, y: PAD.t, width: iw, height: ih, fill: "transparent" });
  overlay.style.cursor = "crosshair";

  function showAt(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let i = Math.round(((px - PAD.l) / iw) * (ds.length - 1));
    i = Math.max(0, Math.min(ds.length - 1, i));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    cross.setAttribute("opacity", 1);

    const t = tip();
    t.innerHTML = "";
    const projected = proj && i > splitIdx;
    t.appendChild(el("div", "tip-date",
      projected ? ds[i] + " · projected"
                : (state.source === "demo" ? ds[i] + " (demo)" : ds[i])));

    if (projected) {
      const k = i - splitIdx - 1;
      const row = el("div", "tip-row");
      const sw = el("span", "swatch"); sw.style.background = SERIES[0]; sw.style.opacity = "0.6";
      row.appendChild(sw);
      row.appendChild(el("span", null, "Projected"));
      row.appendChild(el("span", "val", yFmt(proj.values[k])));
      t.appendChild(row);
      // The range is the point. Showing a single projected number without it
      // would restate the false precision the band exists to avoid.
      const rng = el("div", "tip-row");
      rng.appendChild(el("span", "swatch"));
      rng.appendChild(el("span", null, "Range"));
      rng.appendChild(el("span", "val", yFmt(proj.lo[k]) + " – " + yFmt(proj.hi[k])));
      t.appendChild(rng);
      dots.forEach((d) => d.setAttribute("opacity", 0));
      t.classList.remove("hidden");
      const tw0 = t.offsetWidth, th0 = t.offsetHeight;
      let tx0 = clientX + 14, ty0 = clientY - th0 - 10;
      if (tx0 + tw0 > innerWidth - 8) tx0 = clientX - tw0 - 14;
      if (ty0 < 8) ty0 = clientY + 16;
      t.style.left = tx0 + "px"; t.style.top = ty0 + "px";
      return;
    }

    sr.forEach((s, si) => {
      const v = s.values[i];
      if (v == null) { dots[si].setAttribute("opacity", 0); return; }
      dots[si].setAttribute("cx", x(i)); dots[si].setAttribute("cy", y(v)); dots[si].setAttribute("opacity", 1);
      const row = el("div", "tip-row");
      const sw = el("span", "swatch"); sw.style.background = s.color;
      row.appendChild(sw);
      row.appendChild(el("span", null, s.name));
      row.appendChild(el("span", "val", opts.tipFmt ? opts.tipFmt(v) : yFmt(v)));
      t.appendChild(row);
    });
    t.classList.remove("hidden");
    const tw = t.offsetWidth, th = t.offsetHeight;
    let tx = clientX + 14, ty = clientY - th - 10;
    if (tx + tw > innerWidth - 8) tx = clientX - tw - 14;
    if (ty < 8) ty = clientY + 16;
    t.style.left = tx + "px"; t.style.top = ty + "px";
  }
  function hide() {
    cross.setAttribute("opacity", 0);
    dots.forEach((d) => d.setAttribute("opacity", 0));
    tip().classList.add("hidden");
  }
  overlay.addEventListener("mousemove", (e) => showAt(e.clientX, e.clientY));
  overlay.addEventListener("mouseleave", hide);
  overlay.addEventListener("touchstart", (e) => { const t0 = e.touches[0]; showAt(t0.clientX, t0.clientY); }, { passive: true });
  overlay.addEventListener("touchmove", (e) => { const t0 = e.touches[0]; showAt(t0.clientX, t0.clientY); }, { passive: true });
  overlay.addEventListener("touchend", hide);

  container.appendChild(svg);
}

function sparkline(values, color) {
  const w = 90, h = 26, pad = 2;
  const vals = values.filter((v) => v != null);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w); svg.setAttribute("height", h);
  svg.setAttribute("aria-hidden", "true");
  if (vals.length < 2) return svg;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const x = (i) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = (v) => mx === mn ? h / 2 : pad + (h - pad * 2) - ((v - mn) / (mx - mn)) * (h - pad * 2);
  let d = "", open = false;
  values.forEach((v, i) => {
    if (v == null) { open = false; return; }
    d += (open ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
    open = true;
  });
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d); p.setAttribute("fill", "none");
  p.setAttribute("stroke", color); p.setAttribute("stroke-width", 1.5);
  svg.appendChild(p);
  return svg;
}

/* ------------------------------------------------------------ segmented tabs */
function segTabs(container, options, selected, onPick) {
  container.innerHTML = "";
  options.forEach((opt) => {
    const b = el("button", null, opt);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(opt === selected));
    b.addEventListener("click", () => onPick(opt));
    container.appendChild(b);
  });
}

/* ------------------------------------------------------------ renderers */
function tierChip(tier) {
  const c = el("span", "tier-chip " + (tier || "").toLowerCase(), tier || "—");
  return c;
}

function renderHero() {
  const dates = state.dates;
  const last = dates.length - 1;
  const a = state.alliance;
  const cur = a[last];
  const d1 = seriesDelta(a.map((x) => x.total), idxDaysAgo(1));
  const d7 = seriesDelta(a.map((x) => x.total), idxDaysAgo(7));

  $("#heroNote").textContent =
    `Latest snapshot ${dates[last]} · ${dates.length} daily snapshots on record (${dates[0]} → ${dates[last]})`;

  const stats = [
    { label: STR("statTotalPower"), value: fmtPower(cur.total), delta: d1, deltaLabel: "24h" },
    { label: STR("statGrowth7d"), value: d7 ? fmtSigned(d7.abs) : "—", delta: d7, deltaLabel: "", pctOnly: true },
    { label: STR("statCommanders"), value: String(cur.count), delta: null },
    { label: STR("statAvgPower"), value: fmtPower(cur.count ? cur.total / cur.count : null), delta: null },
  ];
  const row = $("#heroStats");
  row.innerHTML = "";
  for (const s of stats) {
    const box = el("div", "stat");
    box.appendChild(el("div", "label", s.label));
    box.appendChild(el("div", "value", s.value));
    if (s.delta) {
      const cls = deltaClass(s.delta.abs);
      const txt = s.pctOnly
        ? fmtPct(s.delta.pct)
        : `${fmtSigned(s.delta.abs)} (${fmtPct(s.delta.pct)}) ${s.deltaLabel}`;
      box.appendChild(el("div", "delta " + cls, (cls === "up" ? "▲ " : cls === "down" ? "▼ " : "") + txt));
    }
    row.appendChild(box);
  }
}

/* ==================================================== power projection

   A least-squares fit over recent daily totals, extended forward with a
   prediction interval.

   Two things this deliberately does NOT do. It does not fit a curve — with a
   fortnight of data any curve can be made to look convincing, and an alliance
   that adds members in steps is not smooth anyway. And it does not draw a bare
   line: the band comes from the fit's own residuals, so a noisy fortnight
   produces a visibly uncertain projection instead of a confident-looking one.
   ============================================================================ */

function projectionCfg() {
  return CFG.projection || {};
}

/** Days between two ISO dates. Uses real dates, so a missed day is a gap. */
function dayOffset(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
}

/**
 * Least-squares fit of total power against day offset, plus a prediction
 * interval. Returns null when there is not enough to say anything honest.
 */
function fitPower(dates, totals, windowDays) {
  /* Skip incomplete snapshots.

     A day where the scrape captured 11 of 100 commanders is not a day the
     alliance was weak — it is a day the measurement failed. Left in, the jump
     back to a full roster reads as explosive growth: on this data it turned
     118M/day into 781M/day, a 6.6x overstatement pointing at a number the
     alliance will never hit.

     Judged against the fullest roster seen, not the latest, so one bad scrape
     today cannot drag the threshold down and admit every other bad day. */
  const counts = state.alliance.map((a) => (a && a.count) || 0);
  const fullest = Math.max(0, ...counts);
  const minShare = Number(projectionCfg().minCompleteness);
  const floor = fullest * (minShare > 0 && minShare <= 1 ? minShare : 0.8);

  const pts = [];
  let skipped = 0;
  for (let i = 0; i < dates.length; i++) {
    const v = totals[i];
    if (v == null || !isFinite(v)) continue;
    if (fullest > 0 && counts[i] < floor) { skipped++; continue; }
    pts.push({ t: dayOffset(dates[0], dates[i]), v });
  }
  if (!pts.length) return null;

  const lastT = pts[pts.length - 1].t;
  const win = Number(windowDays) > 0
    ? pts.filter((p) => p.t > lastT - Number(windowDays))
    : pts;

  const n = win.length;
  if (n < Math.max(3, Number(projectionCfg().minPoints) || 5)) return null;

  const mt = win.reduce((a, p) => a + p.t, 0) / n;
  const mv = win.reduce((a, p) => a + p.v, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of win) { sxx += (p.t - mt) ** 2; sxy += (p.t - mt) * (p.v - mv); }
  if (sxx === 0) return null;                       // every point on one day

  const slope = sxy / sxx;                          // power per day
  const intercept = mv - slope * mt;

  // Residual standard error. n-2 because two parameters were estimated; with
  // n === 2 the fit is exact and says nothing about spread, so refuse.
  if (n < 3) return null;
  let ss = 0;
  for (const p of win) ss += (p.v - (intercept + slope * p.t)) ** 2;
  const se = Math.sqrt(ss / (n - 2));

  // ~80% two-sided. A t table would be more correct for small n; this is the
  // normal approximation, and the band is already wide enough that the
  // difference does not change any decision anyone makes from this chart.
  const z = Number(projectionCfg().confidence) >= 0.95 ? 1.96 : 1.282;

  return {
    n, slope, intercept, se, z, mt, sxx, lastT, skipped,
    at(t) { return this.intercept + this.slope * t; },
    // Standard prediction interval: wider than the confidence interval on the
    // mean, because it has to cover one future observation rather than the
    // average of many.
    marginAt(t) {
      return this.z * this.se * Math.sqrt(1 + 1 / this.n + ((t - this.mt) ** 2) / this.sxx);
    },
  };
}

/** Future dates + fitted values + band, ready to hand to lineChart. */
function projectPower(days) {
  const cfg = projectionCfg();
  if (!cfg.enabled || !days) return null;

  const dates = state.dates;
  const totals = state.alliance.map((a) => a.total);
  const fit = fitPower(dates, totals, cfg.windowDays);
  if (!fit) return null;

  const last = dates[dates.length - 1];
  const out = { dates: [], values: [], lo: [], hi: [], fit };
  for (let d = 1; d <= days; d++) {
    const t = fit.lastT + d;
    const v = fit.at(t);
    const m = fit.marginAt(t);
    const iso = new Date(Date.parse(last) + d * 86400000).toISOString().slice(0, 10);
    out.dates.push(iso);
    out.values.push(v);
    out.lo.push(Math.max(0, v - m));
    out.hi.push(v + m);
  }
  return out;
}

function renderAllianceChart() {
  const opts = ["7D", "30D", "ALL"];
  segTabs($("#allianceRange"), opts, state.allianceRange, (o) => { state.allianceRange = o; renderAllianceChart(); });

  const cfg = projectionCfg();
  const note = $("#projNote");
  const tabsBox = $("#allianceProject");

  // The toggle only exists when a projection could be honest. Offering it on
  // three days of history and then refusing to draw anything would be worse
  // than not offering it.
  const horizons = (cfg.horizons || []).map(Number).filter((d) => d > 0);
  const maxH = Number(cfg.maxHorizon) > 0 ? Number(cfg.maxHorizon) : 180;
  const canProject = cfg.enabled && !!projectPower(horizons[0] || 7);
  const custom = $("#projCustom");
  const daysInput = $("#projDaysInput");

  if (tabsBox) {
    if (!canProject) {
      tabsBox.innerHTML = "";
      if (custom) custom.classList.add("hidden");
      state.projectDays = 0;
    } else {
      const labels = ["OFF", ...horizons.map((d) => "+" + d + "D")];
      // A typed horizon that happens to equal a preset should light that
      // preset up rather than leaving every tab looking unselected.
      const current = state.projectDays && horizons.includes(state.projectDays)
        ? "+" + state.projectDays + "D"
        : (state.projectDays ? "" : "OFF");
      segTabs(tabsBox, labels, current, (o) => {
        state.projectDays = o === "OFF" ? 0 : Number(String(o).replace(/\D/g, ""));
        renderAllianceChart();
      });

      if (custom && daysInput) {
        custom.classList.remove("hidden");
        daysInput.max = String(maxH);
        // Only rewrite the field when it is not being typed in, or the cursor
        // jumps to the end on every keystroke.
        if (document.activeElement !== daysInput) {
          daysInput.value = state.projectDays ? String(state.projectDays) : "";
        }
        daysInput.placeholder = String(horizons[0] || 7);
        if (!daysInput.dataset.wired) {
          daysInput.dataset.wired = "1";
          daysInput.addEventListener("input", () => {
            const raw = daysInput.value.trim();
            if (!raw) { state.projectDays = 0; renderAllianceChart(); return; }
            let d = Math.floor(Number(raw));
            if (!isFinite(d) || d < 1) return;      // mid-typing, leave it alone
            if (d > maxH) { d = maxH; daysInput.value = String(maxH); }
            state.projectDays = d;
            renderAllianceChart();
          });
        }
      }
    }
  }

  const proj = state.projectDays ? projectPower(state.projectDays) : null;

  const startIdx = state.allianceRange === "ALL" ? 0 : idxDaysAgo(WINDOWS[state.allianceRange]);
  lineChart($("#allianceChart"), {
    dates: state.dates,
    startIdx,
    series: [{ name: "Alliance power", color: SERIES[0], values: state.alliance.map((a) => a.total), endLabel: false }],
    area: true,
    height: 280,
    projection: proj,
  });

  if (note) {
    if (!proj) { note.classList.add("hidden"); note.textContent = ""; }
    else {
      const f = proj.fit;
      const end = proj.values[proj.values.length - 1];
      const lo = proj.lo[proj.lo.length - 1], hi = proj.hi[proj.hi.length - 1];
      // Say what it was fitted from. A projection whose basis is invisible
      // invites more trust than it has earned.
      const win = Number(cfg.windowDays) > 0 ? ` in the last ${cfg.windowDays} days` : "";
      note.textContent =
        `Projected from ${f.n} snapshot${f.n === 1 ? "" : "s"}${win} — ` +
        `${fmtPower(f.slope)} a day on average. In ${state.projectDays} days: ` +
        `${fmtPower(end)} (range ${fmtPower(lo)} – ${fmtPower(hi)}).` +
        (f.skipped
          ? ` ${f.skipped} incomplete snapshot${f.skipped === 1 ? "" : "s"} ignored.`
          : "");
      note.classList.remove("hidden");
    }
  }
}

/* Commanders whose first-ever snapshot is the newest one — i.e. they appeared
   in today's scrape and in no earlier day we hold. Two guards matter:
   firstIdx > 0 excludes everyone present on the oldest day we have (on the very
   first snapshot the whole alliance would otherwise read as brand new), and a
   single-day history can't establish newness at all. Someone who left and came
   back keeps their original first day, so they are not flagged here. */
function newcomers() {
  const last = state.dates.length - 1;
  if (last < 1) return [];
  return [...state.members.values()]
    .filter((m) => m.active && m.firstIdx === last && m.firstIdx > 0)
    .sort((a, b) => a.latestRank - b.latestRank);
}

function renderNewcomers() {
  const section = $("#newcomers");
  if (!section) return;                 // markup older than this script
  const list = newcomers();
  if (!list.length) {
    section.classList.add("hidden");
    $("#welcomeList").innerHTML = "";   // don't leave yesterday's arrivals behind
    return;
  }

  setTitle($("#newcomersTitle"), "newcomers");
  $("#welcomeNote").textContent = STR("welcomeNote");

  const box = $("#welcomeList");
  box.innerHTML = "";
  for (const m of list) {
    const card = el("article", "welcome-card clickable");
    card.tabIndex = 0;
    card.appendChild(avatarEl(m.name, 64));
    const meta = el("div", "welcome-meta");
    const top = el("div", "welcome-name-row");
    top.appendChild(el("span", "welcome-name", m.name));
    top.appendChild(tierChip(m.tier));
    meta.appendChild(top);
    meta.appendChild(el("div", "welcome-stat",
      `#${m.latestRank} · ${fmtPower(m.latestPower)}`));
    card.appendChild(meta);
    card.appendChild(el("span", "welcome-flag", STR("welcomeFlag")));
    const open = () => openDossier(m.name);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    box.appendChild(card);
  }
  section.classList.remove("hidden");
}

function hofCard(w, featured) {
  const card = el("article", "hof-card" + (featured ? " featured" : ""));
  card.setAttribute("role", "listitem");
  card.appendChild(avatarEl(w.name, featured ? 128 : 96));
  const meta = el("div", "hof-meta");
  meta.appendChild(el("div", "hof-event", w.event ? STR("hofEvent") + " " + w.event : STR("hofEvent")));
  meta.appendChild(el("div", "hof-name", w.name));
  if (w.week) meta.appendChild(el("div", "hof-week", w.week));
  card.appendChild(meta);
  if (featured) card.appendChild(el("span", "hof-flag", STR("hofLatest")));
  // a winner who is still in the alliance links through to their dossier
  if (state.members.has(w.name)) {
    card.classList.add("clickable");
    card.tabIndex = 0;
    const open = () => openDossier(w.name);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  }
  return card;
}

function renderHallOfFame() {
  const section = $("#hallOfFame");
  if (!section) return;                 // markup older than this script

  /* Only current members appear. A champion who has left the alliance drops
     off the wall entirely, which can leave gaps in the event sequence — that
     is intended. Names are logged because a hidden entry is indistinguishable
     from a misspelling between the sheet and the roster. */
  const shown = HOF.filter((w) => {
    const m = state.members.get(w.name);
    return m && m.active;
  });
  const hidden = HOF.filter((w) => !shown.includes(w)).map((w) => w.event + ": " + w.name);
  if (hidden.length) console.info("Hall of fame — not in the active roster:", hidden.join(", "));

  if (!shown.length) { section.classList.add("hidden"); return; }
  setTitle($("#hofTitle"), "hallOfFame");

  // The current winner sits outside the scroller entirely, so scrolling back
  // through older events never pushes them off screen.
  const featured = $("#hofFeatured");
  featured.innerHTML = "";
  featured.appendChild(hofCard(shown[0], true));

  const track = $("#hofTrack");
  track.innerHTML = "";
  for (const w of shown.slice(1)) track.appendChild(hofCard(w, false));
  track.classList.toggle("hidden", shown.length < 2);

  section.classList.remove("hidden");
  updateHofNav();
  restartHofAuto();          // card set just changed — remeasure and resume
}

/* Arrows only exist when the rail actually overflows — with three winners on a
   wide screen there is nothing to scroll to. */
function updateHofNav() {
  const track = $("#hofTrack"), nav = $("#hofNav");
  if (!track || !nav) return;
  const overflows = track.scrollWidth > track.clientWidth + 4;
  nav.classList.toggle("hidden", !overflows);
  const end = track.scrollWidth - track.clientWidth - 2;
  $("#hofPrev").disabled = track.scrollLeft <= 2;
  $("#hofNext").disabled = track.scrollLeft >= end;
}

/* ------------------------------------------- hall of fame auto-scroll
   Only #hofTrack moves. The current champion lives in #hofFeatured, a sibling
   of the rail rather than a card inside it, so "everything except the latest"
   already is the track's contents — nothing here has to exclude them.

   This ping-pongs to the end and back instead of looping like a marquee. A
   seamless loop needs a second copy of every card, and that duplicate would
   land in scrollWidth, which is exactly what updateHofNav() measures to decide
   whether the arrows are usable — so a marquee would quietly leave the arrows
   lying about where the rail ends. Reversing keeps one copy of each card and
   the existing nav logic stays true.

   Direct scrollLeft writes are deliberate: .hof-track has no CSS
   scroll-behavior (see styles.css), so each frame lands instantly instead of
   queueing a smooth scroll that would fight the next frame. */
const HOF_SPEED     = 26;     // px/sec — slow enough to actually read a name
const HOF_END_HOLD  = 1400;   // ms paused at each end before reversing
const HOF_USER_IDLE = 2500;   // ms of stillness before we take back over

const hofAuto = { raf: 0, dir: 1, pos: 0, last: 0, holdUntil: 0, userTimer: 0 };
/* Several independent things can hold the animation (hover, focus, a manual
   scroll, a hidden tab, scrolled out of view). A set means the last one to let
   go is what restarts it — a plain boolean would let a mouseleave resume a
   scroll that a hidden tab still wants stopped. */
const hofHolds = new Set();

const hofReduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function hofOverflows() {
  const t = $("#hofTrack");
  return !!t && !t.classList.contains("hidden") && t.scrollWidth > t.clientWidth + 4;
}

function stopHofAuto() {
  if (hofAuto.raf) cancelAnimationFrame(hofAuto.raf);
  hofAuto.raf = 0;
}

function restartHofAuto() {
  stopHofAuto();
  const t = $("#hofTrack");
  if (!t || hofHolds.size || hofReduceMotion() || !hofOverflows()) return;
  hofAuto.pos = t.scrollLeft;   // resync: the user may have dragged the rail
  hofAuto.last = 0;
  hofAuto.holdUntil = 0;
  hofAuto.raf = requestAnimationFrame(hofStep);
}

function hofStep(ts) {
  const t = $("#hofTrack");
  if (!t) { hofAuto.raf = 0; return; }
  const end = t.scrollWidth - t.clientWidth;
  if (end <= 2) { hofAuto.raf = 0; return; }   // window grew; nothing left to scroll

  if (!hofAuto.last) hofAuto.last = ts;
  // Clamped so a tab that was backgrounded mid-frame does not resume with a
  // multi-second delta and teleport the rail to the far end.
  const dt = Math.min((ts - hofAuto.last) / 1000, 0.05);
  hofAuto.last = ts;

  if (ts >= hofAuto.holdUntil) {
    // Position is tracked as a float and written each frame; at 26 px/sec a
    // frame moves ~0.4px, which integer-rounded scrollLeft would swallow
    // entirely and the rail would never move.
    hofAuto.pos += hofAuto.dir * HOF_SPEED * dt;
    if (hofAuto.pos >= end)     { hofAuto.pos = end; hofAuto.dir = -1; hofAuto.holdUntil = ts + HOF_END_HOLD; }
    else if (hofAuto.pos <= 0)  { hofAuto.pos = 0;   hofAuto.dir =  1; hofAuto.holdUntil = ts + HOF_END_HOLD; }
    t.scrollLeft = hofAuto.pos;
  }
  hofAuto.raf = requestAnimationFrame(hofStep);
}

function hofHold(reason, on) {
  if (on) hofHolds.add(reason); else hofHolds.delete(reason);
  if (hofHolds.size) stopHofAuto(); else restartHofAuto();
}

/* A manual scroll, arrow press or key wins for a beat, then we resume. */
function hofUserTouched() {
  hofHold("user", true);
  clearTimeout(hofAuto.userTimer);
  hofAuto.userTimer = setTimeout(() => hofHold("user", false), HOF_USER_IDLE);
}

function wireHofAuto() {
  const section = $("#hallOfFame"), track = $("#hofTrack");
  if (!section || !track) return;

  section.addEventListener("mouseenter", () => hofHold("hover", true));
  section.addEventListener("mouseleave", () => hofHold("hover", false));
  section.addEventListener("focusin",    () => hofHold("focus", true));
  section.addEventListener("focusout",   () => hofHold("focus", false));

  for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    section.addEventListener(ev, hofUserTouched, { passive: true });
  }

  document.addEventListener("visibilitychange", () => hofHold("hidden", document.hidden));

  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(
      ([e]) => hofHold("offscreen", !e.isIntersecting),
      { threshold: 0 },
    ).observe(section);
  }

  // A resize can create or remove the overflow entirely, so remeasure.
  addEventListener("resize", restartHofAuto);

  // Someone flipping the OS setting mid-session should stop it immediately.
  if (typeof matchMedia === "function") {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => (mq.matches ? stopHofAuto() : restartHofAuto());
    if (mq.addEventListener) mq.addEventListener("change", onChange);
  }
}

function wireHallOfFame() {
  const track = $("#hofTrack");
  if (!track) return;
  const step = () => {
    const card = track.querySelector(".hof-card");
    return card ? (card.offsetWidth + 12) * 2 : 320;   // two cards per press
  };
  const press = (dir) => {
    track.scrollBy({ left: dir * step(), behavior: "smooth" });
    setTimeout(updateHofNav, 400);   // don't rely on scroll events alone for the arrow states
  };
  $("#hofPrev").addEventListener("click", () => press(-1));
  $("#hofNext").addEventListener("click", () => press(1));
  // recheck once scrolling settles too — a smooth scroll can land after the
  // last scroll event we saw, which would leave an arrow wrongly enabled
  let settle;
  track.addEventListener("scroll", () => {
    updateHofNav();
    clearTimeout(settle);
    settle = setTimeout(updateHofNav, 120);
  }, { passive: true });
  addEventListener("resize", updateHofNav);
}

function renderMovers() {
  const opts = ["1D", "7D", "30D", "ALL"];
  segTabs($("#moversRange"), opts, state.moversRange, (o) => { state.moversRange = o; renderMovers(); });
  const fromIdx = idxDaysAgo(WINDOWS[state.moversRange]);

  const rows = [];
  for (const m of state.members.values()) {
    if (!m.active) continue;
    const d = seriesDelta(m.power, fromIdx);
    if (d && d.abs !== 0) rows.push({ m, d });
  }
  const gainers = rows.filter((r) => r.d.abs > 0).sort((a, b) => b.d.abs - a.d.abs).slice(0, 10);
  const losers = rows.filter((r) => r.d.abs < 0).sort((a, b) => a.d.abs - b.d.abs).slice(0, 10);

  const maxAbs = Math.max(1, ...gainers.map((r) => r.d.abs), ...losers.map((r) => -r.d.abs));

  const paint = (listEl, items, dir) => {
    listEl.innerHTML = "";
    if (!items.length) { listEl.appendChild(el("div", "empty", dir === "up" ? STR("noGains") : STR("noDeclines"))); return; }
    for (const { m, d } of items) {
      const btn = el("button", "bar-row");
      btn.type = "button";
      btn.setAttribute("aria-label", `${m.name}: ${fmtSigned(d.abs)} (${fmtPct(d.pct)})`);
      const who = el("div", "who");
      who.appendChild(tierChip(m.tier));
      who.appendChild(el("span", "name", m.name));
      btn.appendChild(who);
      btn.appendChild(el("span", "amt " + dir, `${fmtSigned(d.abs)} · ${fmtPct(d.pct)}`));
      const track = el("div", "track");
      const fill = el("div", "fill" + (dir === "down" ? " down" : ""));
      fill.style.width = Math.max(2, (Math.abs(d.abs) / maxAbs) * 100).toFixed(1) + "%";
      track.appendChild(fill);
      btn.appendChild(track);
      btn.addEventListener("click", () => openDossier(m.name));
      listEl.appendChild(btn);
    }
  };
  paint($("#gainersList"), gainers, "up");
  paint($("#losersList"), losers, "down");
}

/* Sortable roster columns. `dir` is the direction a first click picks — ranks
   read best smallest-first, everything else biggest-first. Rows with no value
   (a commander too new to have a 7d delta) always sink to the bottom, whichever
   way the column is pointing. */
const TIER_ORDER = ["R5", "R4", "R3", "R2", "R1"];
const ROSTER_SORTS = {
  rank:      { dir: "asc",  value: (r) => r.m.latestRank },
  commander: { dir: "asc",  value: (r) => r.m.name, text: true },
  tier:      { dir: "desc", value: (r) => { const i = TIER_ORDER.indexOf(r.m.tier); return i === -1 ? null : TIER_ORDER.length - i; } },
  power:     { dir: "desc", value: (r) => r.m.latestPower },
  d1:        { dir: "desc", value: (r) => (r.d1 ? r.d1.abs : null) },
  d7:        { dir: "desc", value: (r) => (r.d7 ? r.d7.abs : null) },
};

function sortRoster(rows, key, dir) {
  const col = ROSTER_SORTS[key] || ROSTER_SORTS.rank;
  const sign = dir === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const va = col.value(a), vb = col.value(b);
    if (va == null || vb == null) {
      if (va == null && vb == null) return a.m.latestRank - b.m.latestRank;
      return va == null ? 1 : -1;
    }
    const c = col.text ? String(va).localeCompare(String(vb)) : va - vb;
    return c ? c * sign : a.m.latestRank - b.m.latestRank;   // rank breaks ties
  });
}

function renderRoster(filter = "") {
  const tbody = $("#rosterTable tbody");
  tbody.innerHTML = "";
  const idx1 = idxDaysAgo(1), idx7 = idxDaysAgo(7);
  const rows = [...state.members.values()]
    .filter((m) => m.active)
    .filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()))
    .map((m) => ({ m, d1: seriesDelta(m.power, idx1), d7: seriesDelta(m.power, idx7) }));
  sortRoster(rows, state.rosterSort.key, state.rosterSort.dir);

  document.querySelectorAll("#rosterTable th[data-sort]").forEach((th) => {
    const on = th.dataset.sort === state.rosterSort.key;
    if (on) th.setAttribute("aria-sort", state.rosterSort.dir === "asc" ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });

  for (const { m, d1, d7 } of rows) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;

    const cells = [
      el("td", "num", "#" + m.latestRank),
      (() => {
        const td = el("td");
        const who = el("div", "who-cell");
        who.appendChild(avatarEl(m.name, 30));
        who.appendChild(el("span", "name", m.name));
        td.appendChild(who);
        return td;
      })(),
      (() => { const td = el("td"); td.appendChild(tierChip(m.tier)); return td; })(),
      el("td", "num power", fmtPower(m.latestPower)),
      el("td", "num delta " + deltaClass(d1 ? d1.abs : 0), d1 ? fmtSigned(d1.abs) : "—"),
      el("td", "num delta " + deltaClass(d7 ? d7.abs : 0), d7 ? fmtSigned(d7.abs) : "—"),
      (() => { const td = el("td"); td.appendChild(sparkline(m.power.slice(-30), SERIES[0])); return td; })(),
    ];
    cells.forEach((c) => tr.appendChild(c));
    const open = () => openDossier(m.name);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    tbody.appendChild(tr);
  }
}

/* Header clicks re-sort the roster: a new column starts in its natural
   direction, the current column flips. */
function wireRosterSort() {
  document.querySelectorAll("#rosterTable th[data-sort]").forEach((th) => {
    const key = th.dataset.sort;
    const pick = () => {
      const cur = state.rosterSort;
      state.rosterSort = cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: ROSTER_SORTS[key].dir };
      renderRoster($("#rosterSearch").value || "");
    };
    th.addEventListener("click", pick);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
  });
}

function openDossier(name) {
  state.dossierName = name;
  renderDossier();
  $("#dossier").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDossier() {
  const sel = $("#dossierSelect");
  const names = [...state.members.values()].filter((m) => m.active).sort((a, b) => a.latestRank - b.latestRank).map((m) => m.name);
  if (!state.dossierName || !state.members.has(state.dossierName)) state.dossierName = names[0];

  sel.innerHTML = "";
  for (const n of names) {
    const o = el("option", null, `#${state.members.get(n).latestRank} — ${n}`);
    o.value = n;
    if (n === state.dossierName) o.selected = true;
    sel.appendChild(o);
  }

  const m = state.members.get(state.dossierName);
  const body = $("#dossierBody");
  body.innerHTML = "";
  if (!m) return;

  const dTotal = seriesDelta(m.power, 0);
  const d7 = seriesDelta(m.power, idxDaysAgo(7));
  const daysTracked = m.lastIdx - m.firstIdx >= 0 ? daysBetween(state.dates[m.firstIdx], state.dates[m.lastIdx]) : 0;
  const dailyAvg = dTotal && daysTracked > 0 ? dTotal.abs / daysTracked : null;

  const grid = el("div", "dossier-grid");

  const card = el("div", "panel dossier-card");
  const head = el("div", "dossier-id");
  head.appendChild(avatarEl(m.name, 72));
  const idText = el("div");
  idText.appendChild(el("div", "big-name", m.name));
  idText.appendChild(tierChip(m.tier));
  head.appendChild(idText);
  card.appendChild(head);
  const facts = el("div", "dossier-facts");
  const fact = (label, value, cls) => {
    const f = el("div", "fact");
    f.appendChild(el("div", "label", label));
    f.appendChild(el("div", "value" + (cls ? " delta-val " + cls : ""), value));
    return f;
  };
  facts.appendChild(fact(STR("factRank"), "#" + m.latestRank));
  facts.appendChild(fact(STR("factBestRank"), "#" + m.bestRank));
  facts.appendChild(fact(STR("factPower"), fmtPower(m.latestPower)));
  facts.appendChild(fact(STR("factGrowth7d"), d7 ? `${fmtSigned(d7.abs)} (${fmtPct(d7.pct)})` : "—", d7 ? deltaClass(d7.abs) : null));
  facts.appendChild(fact(STR("factTotalGrowth"), dTotal ? fmtSigned(dTotal.abs) : "—", dTotal ? deltaClass(dTotal.abs) : null));
  facts.appendChild(fact(STR("factAvgDay"), dailyAvg != null ? fmtSigned(dailyAvg) : "—"));
  facts.appendChild(fact(STR("factFirstSeen"), state.dates[m.firstIdx]));
  facts.appendChild(fact(STR("factSnapshots"), String(m.power.filter((v) => v != null).length)));
  card.appendChild(facts);
  grid.appendChild(card);

  const charts = el("div", "dossier-charts");

  const p1 = el("div", "panel");
  const h1 = el("div", "panel-head");
  const t1 = el("h2"); setTitle(t1, "powerOverTime"); h1.appendChild(t1);
  p1.appendChild(h1);
  const c1 = el("div", "chart"); p1.appendChild(c1);
  charts.appendChild(p1);

  const p2 = el("div", "panel");
  const h2 = el("div", "panel-head");
  const t2 = el("h2"); setTitle(t2, "rankOverTime"); h2.appendChild(t2);
  p2.appendChild(h2);
  const c2 = el("div", "chart"); p2.appendChild(c2);
  charts.appendChild(p2);

  grid.appendChild(charts);
  body.appendChild(grid);

  lineChart(c1, {
    dates: state.dates,
    series: [{ name: m.name, color: SERIES[0], values: m.power, endLabel: false }],
    area: true, height: 220,
  });
  lineChart(c2, {
    dates: state.dates,
    series: [{ name: m.name + " rank", color: SERIES[1], values: m.rank, endLabel: false }],
    height: 170, invert: true, integerTicks: true,
    yFmt: (v) => "#" + Math.round(v), tipFmt: (v) => "#" + Math.round(v),
  });
}

function renderCompare() {
  const mPower = STR("modePower"), mIndexed = STR("modeIndexed");
  segTabs($("#compareMode"), [mPower, mIndexed], state.compareMode === "power" ? mPower : mIndexed,
    (o) => { state.compareMode = o === mPower ? "power" : "indexed"; renderCompare(); });

  // default picks: top 3 by rank
  if (!state.compare.length) {
    state.compare = [...state.members.values()].filter((m) => m.active)
      .sort((a, b) => a.latestRank - b.latestRank).slice(0, 3).map((m) => m.name);
  }
  state.compare = state.compare.filter((n) => state.members.has(n));

  // datalist for the picker
  const dl = $("#memberList");
  dl.innerHTML = "";
  for (const m of state.members.values()) {
    if (!m.active || state.compare.includes(m.name)) continue;
    const o = document.createElement("option"); o.value = m.name; dl.appendChild(o);
  }

  // chips
  const chips = $("#compareChips");
  chips.innerHTML = "";
  state.compare.forEach((n, i) => {
    const chip = el("span", "chip");
    const sw = el("span", "swatch"); sw.style.background = SERIES[i];
    chip.appendChild(sw);
    chip.appendChild(el("span", null, n));
    const x = el("button", null, "×");
    x.setAttribute("aria-label", "Remove " + n);
    x.addEventListener("click", () => { state.compare = state.compare.filter((c) => c !== n); renderCompare(); });
    chip.appendChild(x);
    chips.appendChild(chip);
  });

  // legend
  const legend = $("#compareLegend");
  legend.innerHTML = "";
  state.compare.forEach((n, i) => {
    const item = el("span", "legend-item");
    const sw = el("span", "swatch"); sw.style.background = SERIES[i];
    item.appendChild(sw); item.appendChild(el("span", null, n));
    legend.appendChild(item);
  });

  const indexed = state.compareMode === "indexed";
  const series = state.compare.map((n, i) => {
    const m = state.members.get(n);
    let values = m.power;
    if (indexed) {
      const base = m.power[m.firstIdx];
      values = m.power.map((v) => (v == null || !base ? null : ((v / base) - 1) * 100));
    }
    return { name: n, shortName: n.length > 12 ? n.slice(0, 11) + "…" : n, color: SERIES[i], values };
  });

  lineChart($("#compareChart"), {
    dates: state.dates,
    series,
    height: 280,
    yFmt: indexed ? (v) => (v > 0 ? "+" : "") + v.toFixed(1) + "%" : fmtPower,
    tipFmt: indexed ? (v) => (v > 0 ? "+" : "") + v.toFixed(2) + "%" : fmtPower,
  });

  $("#compareHint").textContent = indexed ? STR("compareHintIndexed") : STR("compareHintPower");
}

function addCompare(name) {
  name = (name || "").trim();
  if (!name || !state.members.has(name)) return;
  if (state.compare.includes(name) || state.compare.length >= COMPARE_MAX) return;
  state.compare.push(name);
  $("#compareSearch").value = "";
  renderCompare();
}

function renderTiers() {
  const last = state.dates.length - 1;
  const byTier = new Map();
  for (const m of state.members.values()) {
    if (!m.active || m.power[last] == null) continue;
    const t = m.tier || "—";
    if (!byTier.has(t)) byTier.set(t, { tier: t, count: 0, total: 0 });
    const rec = byTier.get(t);
    rec.count++; rec.total += m.power[last];
  }
  const order = ["R5", "R4", "R3", "R2", "R1"];
  const tiersArr = [...byTier.values()].sort((a, b) => {
    const ia = order.indexOf(a.tier), ib = order.indexOf(b.tier);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const grand = tiersArr.reduce((s, t) => s + t.total, 0) || 1;

  const bar = $("#tierBar");
  bar.innerHTML = "";
  const legend = $("#tierLegend");
  legend.innerHTML = "";
  tiersArr.forEach((t, i) => {
    const seg = el("div", "seg");
    seg.style.flex = String(t.total / grand);
    seg.style.background = SERIES[i % SERIES.length];
    seg.title = `${t.tier}: ${fmtPower(t.total)} (${((t.total / grand) * 100).toFixed(1)}%)`;
    bar.appendChild(seg);
    const item = el("span", "legend-item");
    const sw = el("span", "swatch"); sw.style.background = SERIES[i % SERIES.length];
    item.appendChild(sw);
    item.appendChild(el("span", null, `${t.tier} — ${((t.total / grand) * 100).toFixed(1)}%`));
    legend.appendChild(item);
  });

  const tbody = $("#tierTable tbody");
  tbody.innerHTML = "";
  for (const t of tiersArr) {
    const tr = document.createElement("tr");
    tr.appendChild((() => { const td = el("td"); td.appendChild(tierChip(t.tier)); return td; })());
    tr.appendChild(el("td", "num", String(t.count)));
    tr.appendChild(el("td", "num power", fmtPower(t.total)));
    tr.appendChild(el("td", "num", fmtPower(t.total / t.count)));
    tr.appendChild(el("td", "num", ((t.total / grand) * 100).toFixed(1) + "%"));
    tbody.appendChild(tr);
  }
}

function renderAll() {
  renderHero();
  renderAllianceChart();
  // an unexpected shape in one hand-edited row should cost this section, not
  // the whole page — every later render lives below this call
  try { renderShoutouts(); } catch (e) { console.error("shoutouts render failed:", e); }
  try { renderAlerts(); } catch (e) { console.error("alerts render failed:", e); }
  renderNewcomers();
  renderHallOfFame();
  renderMovers();
  renderRoster($("#rosterSearch").value || "");
  renderDossier();
  renderCompare();
  renderTiers();
  $("#app").setAttribute("aria-busy", "false");
}

/* ------------------------------------------------------------ first paint
   Everything except the newest day is already in localStorage, but rendering
   used to wait on ?action=sheets and the newest day's fetch — several seconds
   of Apps Script latency before anything appeared. This paints the cached
   model straight away; the live load then replaces it in place. */
function paintFromCache() {
  const cache = readCache();
  if (cache.hof && cache.hof.length) { HOF.length = 0; HOF.push(...cache.hof); }
  if (cache.shoutouts && cache.shoutouts.length) { SHOUTOUTS.length = 0; SHOUTOUTS.push(...cache.shoutouts.map(migrateCallout)); }
  const days = Object.values(cache.days || {})
    .filter((d) => d && d.date && Array.isArray(d.rows) && d.rows.length);
  if (!days.length) return false;
  state.source = "cache";
  buildModel(days.map((d) => ({ date: d.date, rows: d.rows })));
  setSourceUI();
  renderAll();
  return true;
}

/* ------------------------------------------------------------ source pill / banners */

/* Dot and label are separate elements so the phone breakpoint can collapse the
   pill to a 28px circle (matching the bell/refresh buttons) by hiding just the
   label. The word then only exists in the accessible name, so set it there. */
function setPill(pill, dot, label, cls, title) {
  pill.className = "data-pill " + cls;
  pill.textContent = "";
  const d = document.createElement("span");
  d.className = "data-pill-dot";
  d.textContent = dot;
  const t = document.createElement("span");
  t.className = "data-pill-text";
  t.textContent = label;
  pill.append(d, t);
  pill.title = title || label;
  pill.setAttribute("aria-label", "Data status: " + label);
}

function setSourceUI() {
  const pill = $("#dataPill");
  if (state.source === "live") {
    setPill(pill, "●", "LIVE", "live", "Live data");
    $("#demoBanner").classList.add("hidden");
  } else if (state.source === "cache") {
    // real numbers, but as of the last visit — say so rather than let them
    // pass for current, since the whole page is 24h and 7d deltas
    setPill(pill, "◍", "SAVED", "cached", "Showing your last saved snapshot — refreshing…");
    $("#demoBanner").classList.add("hidden");
  } else {
    setPill(pill, "◐", "DEMO", "demo", "Demo data");
    $("#demoBanner").classList.remove("hidden");
  }
}

/* Past days are cached and never refetched, so corrections made to an older
   sheet stay invisible until the cache is dropped. This is the manual escape
   hatch; the API URL is left untouched. */
function wireRefresh() {
  const btn = $("#refreshBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    try { localStorage.removeItem(CACHE_KEY); } catch (_) { /* private mode */ }
    btn.classList.add("spinning");
    location.reload();
  });
}

function showError(msg, keptCache) {
  const b = $("#errorBanner");
  b.innerHTML = "";
  b.appendChild(el("strong", null, "Couldn't load alliance data. "));
  b.appendChild(el("span", null, msg +
    (keptCache ? " Showing your last saved snapshot instead. " : " Showing demo data instead. ")));
  const retry = el("button", "link-btn", "Retry");
  retry.addEventListener("click", () => location.reload());
  b.appendChild(retry);
  b.classList.remove("hidden");
}

/* ------------------------------------------------------------ settings */
function wireSettings() {
  const dlg = $("#settingsDialog");
  const openDlg = () => {
    $("#apiInput").value = getApiUrl() || "";
    $("#settingsStatus").textContent = "";
    $("#settingsStatus").className = "settings-status";
    dlg.showModal();
  };
  // Admin-only: the settings panel is hidden from the UI.
  // Open it by appending ?setup to the URL.
  if (new URLSearchParams(location.search).has("setup")) openDlg();

  $("#testSaveBtn").addEventListener("click", async () => {
    const url = $("#apiInput").value.trim().replace(/\/+$/, "");
    const status = $("#settingsStatus");
    if (!url) { status.textContent = "Paste the Web app URL first."; status.className = "settings-status err"; return; }
    status.textContent = "Testing connection…"; status.className = "settings-status";
    try {
      const meta = await fetchJson(url + "?action=sheets", 20000);
      if (!meta.sheets) throw new Error("Response has no 'sheets' field — is this the right URL?");
      localStorage.setItem(API_KEY, url);
      status.textContent = `Connected — found ${meta.count ?? meta.sheets.length} snapshot sheet(s). Reloading…`;
      status.className = "settings-status ok";
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      status.textContent = "Connection failed: " + (e.name === "AbortError" ? "timed out." : e.message) +
        " Make sure the script is deployed as a Web app with access set to 'Anyone'.";
      status.className = "settings-status err";
    }
  });

  $("#useDemoBtn").addEventListener("click", () => {
    localStorage.removeItem(API_KEY);
    localStorage.removeItem(CACHE_KEY);
    location.href = location.pathname; // strip ?api=
  });
}

/* ------------------------------------------------------------ apply config */
function applyConfig() {
  // identity
  document.title = `${CFG.name}${CFG.fullName ? " — " + CFG.fullName : ""} · Alliance HQ`;
  $("#brandMark").textContent = CFG.name;
  $("#footerBrand").textContent = CFG.name;
  $("#brandSub").textContent = [CFG.localName, CFG.fullName].filter(Boolean).join(" · ");
  $("#footerTagline").textContent =
    `${CFG.fullName || CFG.name} — ${CFG.game} alliance headquarters.`;
  $("#footerMotto").textContent = CFG.footerMotto || "";

  // theme accents
  if (CFG.theme) {
    const root = document.documentElement.style;
    if (CFG.theme.accentA) root.setProperty("--taegeuk-red", CFG.theme.accentA);
    if (CFG.theme.accentB) root.setProperty("--taegeuk-blue", CFG.theme.accentB);
  }

  // crest + favicon
  if (CFG.icon) {
    const img = $("#crestImg");
    img.src = CFG.icon;
    img.alt = CFG.name + " alliance crest";
    img.classList.remove("hidden");
    $("#favicon").href = CFG.icon;
  }

  // headings
  $("#heroEyebrow").textContent = STR("situationBoard");
  $("#heroTitle").textContent = STRPAIR("heroTitle").local
    ? STR("heroTitle") : STRPAIR("heroTitle").en;
  setTitle($("#allianceChartTitle"), "allianceChart");
  setTitle($("#moversTitle"), "movers");
  setTitle($("#rosterTitle"), "roster");
  setTitle($("#dossierTitle"), "dossier");
  setTitle($("#compareTitle"), "compare");
  setTitle($("#tiersTitle"), "tiers");
  $("#gainersLabel").textContent = "▲ " + STR("topGainers");
  $("#losersLabel").textContent = "▼ " + STR("declining");

  // table headers & inputs & hints
  document.querySelectorAll("[data-str]").forEach((n) => { n.textContent = STR(n.dataset.str); });
  $("#rosterSearch").placeholder = STR("searchPlaceholder");
  $("#compareSearch").placeholder = STR("addCommander");
  $("#compareAdd").textContent = STR("addBtn");
  $("#rosterHint").textContent = STR("rosterHint");

  // charter
  if (CFG.charter) {
    setTitle($("#charterTitle"), "charter");
    const body = $("#charterBody");
    body.innerHTML = "";
    if (CFG.charter.lead) body.appendChild(el("p", "charter-lead", CFG.charter.lead));
    if (CFG.charter.rules && CFG.charter.rules.length) {
      const grid = el("div", "charter-grid");
      for (const r of CFG.charter.rules) {
        const card = el("div", "rule");
        card.appendChild(el("div", "rule-label", r.label || ""));
        card.appendChild(el("div", "rule-value", r.value || ""));
        if (r.note) card.appendChild(el("div", "rule-note", r.note));
        grid.appendChild(card);
      }
      body.appendChild(grid);
    }
    if (CFG.charter.join) body.appendChild(el("p", "charter-join", CFG.charter.join));
    $("#charter").classList.remove("hidden");
  }
}

/* ------------------------------------------------------------ boot */
/* ================================================== one-tap alert markers

   Treasure, lucky gift, whatever config.alerts lists. Each is an ordinary
   callout row whose Type is the alert key, with a short expiry — no new
   endpoint, no new storage, and it expires by itself like everything else.

   The push notification is the real alert. This is the confirmation you look
   at once the phone has buzzed, so it has to be right about time remaining
   rather than merely present.
   ============================================================================ */

let alertTimer = null;
let alertPoll = null;

function activeAlerts(now) {
  const keys = alertKinds();
  if (!keys.length) return [];
  return SHOUTOUTS.map(migrateCallout)
    .filter((c) => alertFor(c.type) && calloutActive(c, now))
    // One row per kind: a double-posted alert must not stack two markers.
    .reduce((out, c) => {
      const seen = out.find((x) => x.type === c.type);
      if (!seen) out.push(c);
      else if ((c.expires || 0) > (seen.expires || 0)) out[out.indexOf(seen)] = c;
      return out;
    }, [])
    .sort((a, b) => (a.expires || 0) - (b.expires || 0));   // soonest to close, first
}

function alertLabel(a) {
  const l = a.label || {};
  if (typeof l === "string") return l;
  return l.local ? l.local + " · " + (l.en || a.key) : (l.en || a.key);
}

function renderAlerts() {
  const bar = $("#alertBar");
  if (!bar) return;

  const live = activeAlerts(Date.now());
  if (!live.length) {
    bar.innerHTML = "";
    if (alertTimer) { clearInterval(alertTimer); alertTimer = null; }
    return;
  }

  // Rebuild only when the set of live alerts changes, so the per-second
  // countdown never fights the DOM.
  const sig = live.map((c) => c.type + ":" + c.expires).join("|");
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    bar.innerHTML = "";
    for (const c of live) {
      const a = alertFor(c.type);
      const row = el("div", "alert-row alert-" + c.type);
      row.appendChild(el("span", "alert-icon", a.icon || "❗"));
      const text = el("span", "alert-text");
      text.appendChild(el("b", null, alertLabel(a)));
      text.appendChild(el("span", null, c.message || a.note || ""));
      row.appendChild(text);
      const left = el("span", "alert-left");
      left.dataset.expires = String(c.expires || 0);
      row.appendChild(left);
      bar.appendChild(row);
    }
  }

  const tick = () => {
    let stale = false;
    for (const node of bar.querySelectorAll(".alert-left")) {
      const ms = Number(node.dataset.expires) - Date.now();
      if (ms <= 0) { stale = true; continue; }
      const m = Math.floor(ms / 60000);
      const s2 = Math.floor((ms % 60000) / 1000);
      node.textContent = m + ":" + String(s2).padStart(2, "0");
    }
    // Expire on the viewer's own clock. Waiting for the next fetch would leave
    // a marker up after the thing is gone, which is how people learn to stop
    // trusting it.
    if (stale) renderAlerts();
  };
  tick();
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = setInterval(tick, 1000);
}

/** Read the callout tab again and re-render. Cheap: one small sheet. */
async function refreshCallouts() {
  const base = getApiUrl();
  if (!base) return;
  try {
    await loadShoutouts(base.replace(/\/+$/, ""));
    renderAlerts();
    renderShoutouts();
  } catch (_) { /* a failed refresh must never disturb what is on screen */ }
}

/* An alert fired while somebody already had the page open would otherwise
   never appear. Polling only while the tab is visible keeps that from costing
   a request a minute for every backgrounded tab in the alliance. */
function wireAlertRefresh() {
  if (!alertKinds().length) return;

  const start = () => { if (!alertPoll) alertPoll = setInterval(refreshCallouts, 60000); };
  const stop = () => { if (alertPoll) { clearInterval(alertPoll); alertPoll = null; } };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stop(); return; }
    refreshCallouts();       // catch anything fired while we were away
    start();
  });
  if (!document.hidden) start();
}

/* ============================================================ push notifications

   One tap, no name: subscribing stores an anonymous device endpoint, and every
   subscriber gets the same message. There is no login on this site, so asking
   "who are you" would have been an honour-system field that bought targeting
   and cost a step — the step lost.

   The bell lives in the topbar rather than the Shoutouts section head because
   that section is hidden whenever nothing is active, which is precisely when
   somebody would want to turn notifications on.
   ============================================================================ */

const PUSH = { cfg: null, reg: null, sub: null, busy: false };

function pushConfigured() {
  const c = CFG.push || {};
  return !!(c.enabled && c.publicKey && getApiUrl());
}

/** Everything push needs, checked separately so failures can be explained. */
function pushSupported() {
  return window.isSecureContext &&
         "serviceWorker" in navigator &&
         "PushManager" in window &&
         "Notification" in window;
}

/* iPadOS reports itself as MacIntel, so the touch-point check is what
   distinguishes an iPad from a Mac. Both matter: Safari only permits push from
   a home-screen install, and before that Notification is undefined entirely. */
function isIosLike() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches ||
         window.navigator.standalone === true;
}

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* Same transport discipline as admin.js: text/plain keeps this a CORS simple
   request (Apps Script cannot answer a preflight) and credentials are omitted
   because Google cookies make it answer 404 with HTML.

   Retries matter here. Apps Script intermittently answers a perfectly good
   POST with 404 and an HTML body — the same failure postThenVerify exists to
   absorb in admin.js. Without a retry a commander taps "Turn on", sees it
   fail, and is left unsubscribed by a request that may well have landed.

   A JSON reply carrying ok:false is a real refusal and is NOT retried: the
   server understood and said no. Only a lost response is worth asking again.

   `shapeOk` is what makes this safe. Apps Script's other failure mode is a
   redirect that degrades into a GET: doPost never runs, and the reply is
   doGet's default output — the roster sheet, as perfectly valid JSON with no
   `ok` field at all. Checking only for ok:false accepts that as success, so
   the bell turns green while the server has no idea the device exists. */
async function pushApiPost(body, shapeOk, tries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(getApiUrl(), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body),
        redirect: "follow",
        credentials: "omit",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (json && json.ok === false) {
        throw Object.assign(new Error(json.error || "refused"), { refused: true });
      }
      if (shapeOk && !shapeOk(json)) throw new Error("unrecognised reply from " + body.action);
      return json;
    } catch (e) {
      if (e.refused) throw e;
      lastErr = e;
      if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function initPush() {
  if (!pushConfigured()) return;

  const bell = $("#bellBtn");
  if (!bell) return;

  // iOS can subscribe, but only once installed. Show the bell anyway so the
  // requirement is discoverable — a missing control explains nothing.
  if (isIosLike() && !isInstalled()) {
    bell.classList.remove("hidden");
    PUSH.state = "ios";
    wirePushUi();
    return;
  }
  if (!pushSupported()) return;      // nothing we show could ever work

  try {
    // Relative path: on GitHub Pages this registers /kwcl/sw.js at scope
    // /kwcl/, not the origin root.
    PUSH.reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    PUSH.sub = await PUSH.reg.pushManager.getSubscription();
  } catch (e) {
    console.error("Service worker registration failed:", e);
    return;
  }

  bell.classList.remove("hidden");
  wirePushUi();
  renderPushUi();
}

function wirePushUi() {
  if (PUSH.wired) return;
  PUSH.wired = true;

  $("#bellBtn").addEventListener("click", () => {
    const open = $("#pushPanel").classList.toggle("hidden") === false;
    $("#bellBtn").setAttribute("aria-expanded", String(open));
    if (open) renderPushUi();
  });
  $("#pushDismiss").addEventListener("click", closePushPanel);
  $("#pushEnable").addEventListener("click", onPushToggle);

  // Clicking away closes it; Escape closes it. A panel you cannot dismiss
  // without finding the right button is a panel people learn to resent.
  document.addEventListener("click", (e) => {
    if ($("#pushPanel").classList.contains("hidden")) return;
    if (e.target.closest("#pushPanel") || e.target.closest("#bellBtn")) return;
    closePushPanel();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePushPanel(); });
}

function closePushPanel() {
  $("#pushPanel").classList.add("hidden");
  $("#bellBtn").setAttribute("aria-expanded", "false");
}

function renderPushUi() {
  const bell = $("#bellBtn");
  const body = $("#pushPanelBody");
  const go = $("#pushEnable");
  const dismiss = $("#pushDismiss");

  bell.classList.remove("on", "blocked");
  go.classList.remove("busy");
  go.disabled = false;
  go.classList.remove("hidden");
  dismiss.textContent = "Not now";

  if (PUSH.state === "ios") {
    body.innerHTML = "On iPhone and iPad, notifications only work once this page " +
      "is installed. Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>, " +
      "and open it from there.";
    go.classList.add("hidden");
    dismiss.textContent = "Got it";
    return;
  }

  // Blocked is a one-way door — the browser will not prompt again, so say what
  // to do instead of offering a button that silently does nothing.
  if (Notification.permission === "denied") {
    bell.classList.add("blocked");
    body.innerHTML = "Notifications are <strong>blocked</strong> for this site in your " +
      "browser settings. Allow them there, then reload this page.";
    go.classList.add("hidden");
    dismiss.textContent = "Close";
    return;
  }

  if (PUSH.sub) {
    bell.classList.add("on");
    body.innerHTML = "You'll get a notification when an admin posts a shoutout or " +
      "an announcement. <strong>Nothing else.</strong>";
    go.textContent = "Turn off";
    return;
  }

  body.innerHTML = "Get a notification when an admin posts a shoutout or an alliance " +
    "announcement — even with this page closed. <strong>Nothing else, and no name required.</strong>";
  go.textContent = "Turn on";
}

async function onPushToggle() {
  if (PUSH.busy) return;
  const go = $("#pushEnable");
  const body = $("#pushPanelBody");

  PUSH.busy = true;
  go.classList.add("busy");
  go.disabled = true;

  try {
    if (PUSH.sub) {
      const endpoint = PUSH.sub.endpoint;
      await PUSH.sub.unsubscribe();
      PUSH.sub = null;
      // Local first: even if this call is lost, the endpoint is now dead and
      // the next send prunes it on a 410. Self-healing either way.
      await pushApiPost({ action: "push_unsubscribe", endpoint },
                        (r) => r && r.ok === true);
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { renderPushUi(); return; }

      const sub = await PUSH.reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToBytes(CFG.push.publicKey),
      });

      try {
        await pushApiPost({
          action: "push_subscribe",
          subscription: sub.toJSON(),
          ua: navigator.userAgent.slice(0, 180),
        }, (r) => r && r.ok === true && typeof r.created === "boolean");
      } catch (err) {
        // The browser would happily report "subscribed" while the server has
        // no idea the device exists — a state that looks fine and never
        // delivers anything. Roll it back so the UI stays honest.
        await sub.unsubscribe().catch(() => {});
        throw err;
      }

      PUSH.sub = sub;
      // Give the worker what it needs to re-register itself when the browser
      // rotates the endpoint, which happens with no page open to ask.
      navigator.serviceWorker.controller?.postMessage({
        type: "config",
        apiUrl: getApiUrl(),
        publicKey: CFG.push.publicKey,
      });
    }
    renderPushUi();
  } catch (e) {
    console.error("Push toggle failed:", e);
    body.innerHTML = "That didn't work — <strong>" +
      String(e.message || e).replace(/[<>]/g, "") + "</strong>. Try again in a moment.";
    $("#pushEnable").textContent = PUSH.sub ? "Turn off" : "Turn on";
  } finally {
    PUSH.busy = false;
    go.classList.remove("busy");
    go.disabled = false;
  }
}

async function boot() {
  applyConfig();
  wireSettings();
  wireRefresh();
  $("#rosterSearch").addEventListener("input", (e) => renderRoster(e.target.value));
  wireRosterSort();
  wireHallOfFame();
  wireHofAuto();
  $("#dossierSelect").addEventListener("change", (e) => { state.dossierName = e.target.value; renderDossier(); });
  $("#compareAdd").addEventListener("click", () => addCompare($("#compareSearch").value));
  $("#compareSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") addCompare(e.target.value); });
  $("#compareSearch").addEventListener("change", (e) => addCompare(e.target.value));

  await loadAvatarIndex();
  const painted = paintFromCache();

  // Fire and forget: a service worker that fails to register must never stop
  // the alliance numbers from loading.
  initPush().catch((e) => console.error("Push init failed:", e));
  wireAlertRefresh();

  const base = getApiUrl();
  if (base) {
    try {
      const clean = base.replace(/\/+$/, "");
      // Both go out at once — the hall of fame has nothing to do with the
      // snapshots, and Apps Script answers slowly enough (1.5-4s a call) that
      // running it after them added its whole latency to every cold load.
      // loadHallOfFame never rejects, so it cannot take the snapshots down.
      const [snaps] = await Promise.all([loadLive(clean), loadHallOfFame(clean), loadShoutouts(clean)]);
      state.source = "live";
      buildModel(snaps);
      setSourceUI();
      renderAll();
      return;
    } catch (e) {
      console.error("Live load failed:", e);
      showError(e.message || String(e), painted);
      // real-but-stale beats demo numbers: keep what the cache already painted
      if (painted) { state.source = "cache"; setSourceUI(); return; }
    }
  }
  state.source = "demo";
  buildModel(demoSnapshots());
  setSourceUI();
  renderAll();
}

boot();
