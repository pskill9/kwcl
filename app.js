/* ============================================================
   kWcl — Korea World Class · Alliance HQ
   Static client for the Google Apps Script snapshot API.
   ============================================================ */

"use strict";

/* ------------------------------------------------------------
   CONFIG
   ------------------------------------------------------------
   Once the Apps Script Web app is deployed, either:
   1. paste its URL in the ⚙ Data source panel on the page, or
   2. hardcode it here:                                        */
const DEFAULT_API_URL = ""; // e.g. "https://script.google.com/macros/s/DEPLOY_ID/exec"

const MAX_SNAPSHOTS = 120;   // most recent daily sheets to load
const FETCH_CONCURRENCY = 6;
const CACHE_KEY = "kwcl_cache_v1";
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
  try { return localStorage.getItem(API_KEY) || DEFAULT_API_URL; } catch (_) { return DEFAULT_API_URL; }
}

async function fetchJson(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (_) { return {}; }
}
function writeCache(cache, keepNames) {
  try {
    const trimmed = {};
    for (const name of keepNames) if (cache[name]) trimmed[name] = cache[name];
    localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch (_) { /* storage full — skip caching */ }
}

async function loadLive(base) {
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
    if (s.name !== latestName && cache[s.name]) return { date: s.date, rows: cache[s.name] };
    const json = await fetchJson(base + "?action=data&sheet=" + encodeURIComponent(s.name));
    const rows = (json.data || []).map((r) => ({
      rank: Number(r.Rank), name: String(r.Commander || "").trim(),
      tier: String(r.Tier || "").trim().toUpperCase(), power: Number(r.Power),
    })).filter((r) => r.name && isFinite(r.power));
    cache[s.name] = rows;
    return { date: s.date, rows };
  });

  writeCache(cache, sheets.map((s) => s.name));
  return snapshots;
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
    container.appendChild(el("div", "chart-empty", "Need at least two daily snapshots to draw a trend — check back tomorrow."));
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
    { label: "총 전투력 · Total power", value: fmtPower(cur.total), delta: d1, deltaLabel: "24h" },
    { label: "7일 성장 · 7-day growth", value: d7 ? fmtSigned(d7.abs) : "—", delta: d7, deltaLabel: "", pctOnly: true },
    { label: "지휘관 · Commanders", value: String(cur.count), delta: null },
    { label: "평균 전투력 · Avg power", value: fmtPower(cur.count ? cur.total / cur.count : null), delta: null },
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
    if (!items.length) { listEl.appendChild(el("div", "empty", dir === "up" ? "No gains in this window yet." : "Nobody declined — clean sheet.")); return; }
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

function renderRoster(filter = "") {
  const tbody = $("#rosterTable tbody");
  tbody.innerHTML = "";
  const idx1 = idxDaysAgo(1), idx7 = idxDaysAgo(7);
  const members = [...state.members.values()]
    .filter((m) => m.active)
    .filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => a.latestRank - b.latestRank);

  for (const m of members) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    const d1 = seriesDelta(m.power, idx1);
    const d7 = seriesDelta(m.power, idx7);

    const cells = [
      el("td", "num", "#" + m.latestRank),
      (() => { const td = el("td"); td.appendChild(el("span", "name", m.name)); return td; })(),
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
  const nameEl = el("div", "big-name", m.name);
  card.appendChild(nameEl);
  card.appendChild(tierChip(m.tier));
  const facts = el("div", "dossier-facts");
  const fact = (label, value, cls) => {
    const f = el("div", "fact");
    f.appendChild(el("div", "label", label));
    f.appendChild(el("div", "value" + (cls ? " delta-val " + cls : ""), value));
    return f;
  };
  facts.appendChild(fact("Current rank", "#" + m.latestRank));
  facts.appendChild(fact("Best rank", "#" + m.bestRank));
  facts.appendChild(fact("Power", fmtPower(m.latestPower)));
  facts.appendChild(fact("7-day growth", d7 ? `${fmtSigned(d7.abs)} (${fmtPct(d7.pct)})` : "—", d7 ? deltaClass(d7.abs) : null));
  facts.appendChild(fact("Total growth", dTotal ? fmtSigned(dTotal.abs) : "—", dTotal ? deltaClass(dTotal.abs) : null));
  facts.appendChild(fact("Avg / day", dailyAvg != null ? fmtSigned(dailyAvg) : "—"));
  facts.appendChild(fact("First seen", state.dates[m.firstIdx]));
  facts.appendChild(fact("Snapshots", String(m.power.filter((v) => v != null).length)));
  card.appendChild(facts);
  grid.appendChild(card);

  const charts = el("div", "dossier-charts");

  const p1 = el("div", "panel");
  const h1 = el("div", "panel-head"); h1.appendChild(el("h2", null, "전투력 추이 · Power over time"));
  p1.appendChild(h1);
  const c1 = el("div", "chart"); p1.appendChild(c1);
  charts.appendChild(p1);

  const p2 = el("div", "panel");
  const h2 = el("div", "panel-head"); h2.appendChild(el("h2", null, "서열 추이 · Rank over time (1 = top)"));
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
  segTabs($("#compareMode"), ["Power", "Indexed %"], state.compareMode === "power" ? "Power" : "Indexed %",
    (o) => { state.compareMode = o === "Power" ? "power" : "indexed"; renderCompare(); });

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

  $("#compareHint").textContent = indexed
    ? "Indexed: growth since each commander's first snapshot — fair comparison across different power levels."
    : "Absolute power. Switch to Indexed % to compare growth rates fairly.";
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
  renderMovers();
  renderRoster($("#rosterSearch").value || "");
  renderDossier();
  renderCompare();
  renderTiers();
  $("#app").setAttribute("aria-busy", "false");
}

/* ------------------------------------------------------------ source pill / banners */
function setSourceUI() {
  const pill = $("#dataPill");
  if (state.source === "live") {
    pill.textContent = "● LIVE";
    pill.className = "data-pill live";
    $("#demoBanner").classList.add("hidden");
  } else {
    pill.textContent = "◐ DEMO";
    pill.className = "data-pill demo";
    $("#demoBanner").classList.remove("hidden");
  }
}

function showError(msg) {
  const b = $("#errorBanner");
  b.innerHTML = "";
  b.appendChild(el("strong", null, "Couldn't load alliance data. "));
  b.appendChild(el("span", null, msg + " Showing demo data instead. "));
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
  $("#settingsBtn").addEventListener("click", openDlg);
  $("#footerSettings").addEventListener("click", openDlg);
  $("#bannerConnect").addEventListener("click", openDlg);

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

/* ------------------------------------------------------------ boot */
async function boot() {
  wireSettings();
  $("#rosterSearch").addEventListener("input", (e) => renderRoster(e.target.value));
  $("#dossierSelect").addEventListener("change", (e) => { state.dossierName = e.target.value; renderDossier(); });
  $("#compareAdd").addEventListener("click", () => addCompare($("#compareSearch").value));
  $("#compareSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") addCompare(e.target.value); });
  $("#compareSearch").addEventListener("change", (e) => addCompare(e.target.value));

  const base = getApiUrl();
  if (base) {
    try {
      const snaps = await loadLive(base.replace(/\/+$/, ""));
      state.source = "live";
      buildModel(snaps);
      setSourceUI();
      renderAll();
      return;
    } catch (e) {
      console.error("Live load failed:", e);
      showError(e.message || String(e));
    }
  }
  state.source = "demo";
  buildModel(demoSnapshots());
  setSourceUI();
  renderAll();
}

boot();
