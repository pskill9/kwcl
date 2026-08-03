/**
 * Local stand-in for the deployed Apps Script, for driving the site in a
 * browser without touching the live sheet.
 *
 * It does NOT reimplement the callout logic — it loads the real
 * apps-script/Code.gs and calls its doGet/doPost, so what the browser exercises
 * is the same code that gets pasted into Apps Script. Only the Google services
 * underneath are faked (in-memory sheets).
 *
 *   node tools/mock-api.mjs [port] [secret]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8787);
const SECRET = process.argv[3] || "kwcl-test";
/* Reproduces the Apps Script failure mode seen in production: the write is
   executed, then the response comes back 404 with HTML. Pass a number as the
   4th arg — every Nth POST fails this way (1 = every POST). */
const FAIL_EVERY = Number(process.argv[4] || 0);
let postCount = 0;

/* --- fake Google services (same shapes as tools/test-callouts.mjs) --- */
function makeSheet(name, values = []) {
  const grid = values;
  const at = (r, c) => (grid[r] === undefined ? "" : grid[r][c] === undefined ? "" : grid[r][c]);
  const sheet = {
    getName: () => name,
    getIndex: () => 1,
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, row) => Math.max(m, row.length), 0),
    getDataRange: () => sheet.getRange(1, 1, Math.max(grid.length, 1), Math.max(sheet.getLastColumn(), 1)),
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const line = [];
            for (let c = 0; c < numCols; c++) line.push(at(row - 1 + r, col - 1 + c));
            out.push(line);
          }
          return out;
        },
        setValues(vals) {
          for (let r = 0; r < vals.length; r++) {
            const gr = row - 1 + r;
            if (!grid[gr]) grid[gr] = [];
            for (let c = 0; c < vals[r].length; c++) grid[gr][col - 1 + c] = vals[r][c];
          }
          return this;
        },
        setValue(v) { return this.setValues([[v]]); },
      };
    },
    appendRow(row) { grid.push(row.slice()); return sheet; },
  };
  return sheet;
}

/* Two days of plausible snapshot data so the site has charts to draw, plus a
   Roster for the admin datalist. Numbers echo the real 2026-08-01/02 tabs. */
const D1 = "2026-08-01", D2 = "2026-08-02";
const MEMBERS = [
  ["Blackcavalier", "R3", null, 131513767],
  ["피자감자", "R4", 110629272, 112158120],
  ["ENSENDE GEZERİM", "R3", null, 102445884],
  ["포켓캣 cat", "R4", 98052826, 101282505],
  ["멍뭉뇽냥", "R4", 99194298, 99747262],
  ["Jlwoo", "R5", 104921029, 98897898],
  ["워워", "R3", 97692715, 97692715],
  ["아앙아앙s", "R4", 96287722, 97634691],
  ["피콜", "R3", 93054096, 93508973],
  ["룡쓰", "R3", 88574815, 91148036],
  ["RαHee라희", "R4", 87212655, 84802944],
  ["Makpy", "R3", 58589761, 58514417],
  ["Nevatheless", "R2", null, 61629779],
  ["아리ARi", "R3", 14844635, 16535682],
];

function daySheet(name, col) {
  const rows = MEMBERS
    .map((m) => [m[0], m[1], m[2 + col]])
    .filter((r) => r[2] != null)
    .sort((a, b) => b[2] - a[2])
    .map((r, i) => [i + 1, r[0], r[1], r[2]]);
  return makeSheet(name, [["Rank", "Commander", "Tier", "Power"], ...rows]);
}

const sheets = [
  makeSheet("Roster", [
    ["Commander", "Tier", "isActive"],
    ...MEMBERS.map((m) => [m[0], m[1], true]),
    ["The Mansur", "R3", false],
  ]),
  daySheet(D1, 0),
  daySheet(D2, 1),
];

const ss = {
  getSheets: () => sheets,
  getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
  getSpreadsheetTimeZone: () => "Etc/UTC",
  insertSheet(n) { const s = makeSheet(n, []); sheets.push(s); return s; },
};

const props = new Map([["CALLOUT_SECRET", SECRET]]);

const sandbox = {
  SpreadsheetApp: { openById: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null) }) },
  ContentService: {
    MimeType: { JSON: "JSON" },
    createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
  },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
  Logger: { log: () => {} },
  console, Date, JSON, Number, String, Math, isNaN,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(here, "..", "apps-script", "Code.gs"), "utf8"), sandbox, { filename: "Code.gs" });

/* --- HTTP --- */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  const parameter = Object.fromEntries(url.searchParams);

  if (req.method === "GET") {
    const out = sandbox.doGet({ parameter }).getContent();
    console.log(`GET  ${url.search || "/"} -> ${out.length}b`);
    res.writeHead(200, CORS);
    return res.end(out);
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const out = sandbox.doPost({ parameter, postData: { contents: body } }).getContent();
    let tag = "";
    try { tag = JSON.parse(body).action || "insert"; } catch (_) {}
    postCount++;
    if (FAIL_EVERY && postCount % FAIL_EVERY === 0) {
      // write already happened above — only the response is lost
      console.log(`POST ${tag} -> EXECUTED, returning 404/HTML (injected)`);
      res.writeHead(404, { ...CORS, "Content-Type": "text/html" });
      return res.end("<!DOCTYPE html><html><body>Not Found</body></html>");
    }
    console.log(`POST ${tag} -> ${out.slice(0, 90).replace(/\s+/g, " ")}`);
    res.writeHead(200, CORS);
    res.end(out);
  });
}).listen(PORT, () => {
  console.log(`mock Apps Script on http://localhost:${PORT}  (CALLOUT_SECRET="${SECRET}")`);
});
