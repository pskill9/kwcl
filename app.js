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
/* Fill a section-title / panel h2: "현지어 · <span>English</span>" or plain English. */
function setTitle(node, key) {
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
// v3 stores { days: { sheetName: {date, rows} }, hof: [...] }. v2 held rows
// only, with dates supplied by the ?action=sheets response — which is exactly
// what the first paint must not wait for, hence the date living in the cache.
const CACHE_KEY = "kwcl_cache_v3";
const CACHE_KEY_V2 = "kwcl_cache_v2";
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
      const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
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
    if (raw && raw.days) return { days: raw.days, hof: raw.hof || null };
  } catch (_) { /* unparseable — treat as empty */ }
  return { days: {}, hof: null };
}

/* The snapshot and hall-of-fame loaders run concurrently and both persist, so
   each writes only its own half and carries the other half over untouched. */
function saveCache(part) {
  try {
    const cur = readCache();
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      days: part.days || cur.days,
      hof: part.hof === undefined ? cur.hof : part.hof,
    }));
    localStorage.removeItem(CACHE_KEY_V2);   // dead weight once v3 is written
  } catch (_) { /* storage full — skip caching */ }
}

/* One request for every day, columnar so commander names aren't repeated once
   per day. Returns null when the deployed script predates ?action=all — an old
   deployment ignores the unknown action and answers with a single sheet's
   rows, so the shape is what we check, not the HTTP status. */
async function loadBulk(base, since) {
  const url = base + "?action=all&limit=" + MAX_SNAPSHOTS + (since ? "&since=" + since : "");
  const json = await fetchJson(url);
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

async function loadLive(base) {
  // Fast path: ask only for days newer than what's already cached, in one call.
  const cached = readCache().days;
  const byDate = {};
  for (const d of Object.values(cached)) if (d && d.date && Array.isArray(d.rows)) byDate[d.date] = d;
  const newest = Object.keys(byDate).sort().pop() || null;

  const bulk = await loadBulk(base, newest);
  if (bulk) {
    // `since` is inclusive, so the newest cached day comes back refreshed
    for (const s of snapshotsFromBulk(bulk)) byDate[s.date] = { date: s.date, rows: s.rows };
    const all = Object.keys(byDate).sort().slice(-MAX_SNAPSHOTS).map((d) => byDate[d]);
    const days = {};
    for (const d of all) days[d.date] = d;
    saveCache({ days });
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
  } = opts;
  container.innerHTML = "";

  const ds = dates.slice(startIdx);
  const sr = series.map((s) => ({ ...s, values: s.values.slice(startIdx) }));
  if (ds.length < 2) {
    container.appendChild(el("div", "chart-empty", STR("needTwo")));
    return;
  }

  const W = 900, H = height, PAD = { t: 14, r: 74, b: 26, l: 52 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;

  let mn = Infinity, mx = -Infinity;
  for (const s of sr) for (const v of s.values) if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
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
    t.appendChild(el("div", "tip-date", state.source === "demo" ? ds[i] + " (demo)" : ds[i]));
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

function renderAllianceChart() {
  const opts = ["7D", "30D", "ALL"];
  segTabs($("#allianceRange"), opts, state.allianceRange, (o) => { state.allianceRange = o; renderAllianceChart(); });
  const startIdx = state.allianceRange === "ALL" ? 0 : idxDaysAgo(WINDOWS[state.allianceRange]);
  lineChart($("#allianceChart"), {
    dates: state.dates,
    startIdx,
    series: [{ name: "Alliance power", color: SERIES[0], values: state.alliance.map((a) => a.total), endLabel: false }],
    area: true,
    height: 280,
  });
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
  if (!HOF.length) { section.classList.add("hidden"); return; }
  setTitle($("#hofTitle"), "hallOfFame");

  // The current winner sits outside the scroller entirely, so scrolling back
  // through older events never pushes them off screen.
  const featured = $("#hofFeatured");
  featured.innerHTML = "";
  featured.appendChild(hofCard(HOF[0], true));

  const track = $("#hofTrack");
  track.innerHTML = "";
  for (const w of HOF.slice(1)) track.appendChild(hofCard(w, false));
  track.classList.toggle("hidden", HOF.length < 2);

  section.classList.remove("hidden");
  updateHofNav();
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

function wireHallOfFame() {
  const track = $("#hofTrack");
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
function setSourceUI() {
  const pill = $("#dataPill");
  if (state.source === "live") {
    pill.textContent = "● LIVE";
    pill.className = "data-pill live";
    $("#demoBanner").classList.add("hidden");
  } else if (state.source === "cache") {
    // real numbers, but as of the last visit — say so rather than let them
    // pass for current, since the whole page is 24h and 7d deltas
    pill.textContent = "◍ SAVED";
    pill.className = "data-pill cached";
    pill.title = "Showing your last saved snapshot — refreshing…";
    $("#demoBanner").classList.add("hidden");
  } else {
    pill.textContent = "◐ DEMO";
    pill.className = "data-pill demo";
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
async function boot() {
  applyConfig();
  wireSettings();
  wireRefresh();
  $("#rosterSearch").addEventListener("input", (e) => renderRoster(e.target.value));
  wireRosterSort();
  wireHallOfFame();
  $("#dossierSelect").addEventListener("change", (e) => { state.dossierName = e.target.value; renderDossier(); });
  $("#compareAdd").addEventListener("click", () => addCompare($("#compareSearch").value));
  $("#compareSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") addCompare(e.target.value); });
  $("#compareSearch").addEventListener("change", (e) => addCompare(e.target.value));

  await loadAvatarIndex();
  const painted = paintFromCache();

  const base = getApiUrl();
  if (base) {
    try {
      const clean = base.replace(/\/+$/, "");
      // Both go out at once — the hall of fame has nothing to do with the
      // snapshots, and Apps Script answers slowly enough (1.5-4s a call) that
      // running it after them added its whole latency to every cold load.
      // loadHallOfFame never rejects, so it cannot take the snapshots down.
      const [snaps] = await Promise.all([loadLive(clean), loadHallOfFame(clean)]);
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
