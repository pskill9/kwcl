/**
 * Runs the REAL apps-script/Code.gs under node with fake Google services.
 *
 * The point is that this exercises the code you actually paste into the Apps
 * Script editor. A mock server that reimplements the same behaviour would pass
 * happily while the real file was broken.
 *
 *   node tools/test-callouts.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "apps-script", "Code.gs");

/* ---------------------------------------------------------------- fakes */

/** A sheet backed by a 2-D array, mimicking the bits of the API Code.gs uses. */
function makeSheet(name, values = []) {
  const grid = values;
  const at = (r, c) => (grid[r] === undefined ? "" : grid[r][c] === undefined ? "" : grid[r][c]);

  const sheet = {
    _grid: grid,
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

function makeSpreadsheet(sheets) {
  return {
    _sheets: sheets,
    getSheets: () => sheets,
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSpreadsheetTimeZone: () => "Etc/UTC",
    insertSheet(n) { const s = makeSheet(n, []); sheets.push(s); return s; },
  };
}

/* ------------------------------------------------------------- harness */

function loadCodeGs({ secret }) {
  const ss = makeSpreadsheet([
    makeSheet("Roster", [["Commander", "Tier"], ["피자감자", "R4"]]),
    makeSheet("2026-08-02", [["Rank", "Commander", "Power"], [1, "Blackcavalier", 131513767]]),
  ]);

  const props = new Map();
  if (secret !== undefined) props.set("CALLOUT_SECRET", secret);

  const sandbox = {
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null) }) },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
    },
    Utilities: {
      formatDate: (d, _tz, _f) => d.toISOString().slice(0, 10),
    },
    Logger: { log: () => {} },
    console,
    Date,
    JSON,
    Number,
    String,
    Math,
    isNaN,
  };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SRC, "utf8"), sandbox, { filename: "Code.gs" });
  return { sandbox, ss };
}

/* --------------------------------------------------------------- tests */

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? "  -> " + extra : ""}`); }
}

function post(sandbox, ss, params) {
  return sandbox.postCallout(ss, params);
}

console.log("\nCode.gs callout behaviour\n");

/* --- auth --- */
{
  const { sandbox, ss } = loadCodeGs({ secret: "hunter2" });
  const good = post(sandbox, ss, { secret: "hunter2", type: "announcement", message: "hi", hours: 24 });
  check("correct secret is accepted", good.ok === true, JSON.stringify(good));

  const bad = post(sandbox, ss, { secret: "wrong", type: "announcement", message: "hi" });
  check("wrong secret is refused", bad.ok === false && bad.error === "unauthorized", JSON.stringify(bad));

  const none = post(sandbox, ss, { type: "announcement", message: "hi" });
  check("missing secret is refused", none.ok === false && none.error === "unauthorized", JSON.stringify(none));

  const blank = post(sandbox, ss, { secret: "", type: "announcement", message: "hi" });
  check("empty secret is refused", blank.ok === false, JSON.stringify(blank));

  const reply = JSON.stringify(bad);
  check("refusal never echoes the secret", !reply.includes("hunter2"), reply);
}

/* --- fail closed when the property was never set --- */
{
  const { sandbox, ss } = loadCodeGs({});   // no CALLOUT_SECRET at all
  const r = post(sandbox, ss, { secret: "anything", type: "announcement", message: "hi" });
  check("unset CALLOUT_SECRET refuses everyone", r.ok === false && r.error === "unauthorized", JSON.stringify(r));
  const empty = loadCodeGs({ secret: "   " });
  const r2 = post(empty.sandbox, empty.ss, { secret: "   ", type: "announcement", message: "hi" });
  check("whitespace-only CALLOUT_SECRET refuses everyone", r2.ok === false, JSON.stringify(r2));
}

/* --- tab + headers created on first write --- */
{
  const { sandbox, ss } = loadCodeGs({ secret: "s" });
  check("Shoutouts tab absent before first write", ss.getSheetByName("Shoutouts") === null);
  post(sandbox, ss, { secret: "s", type: "announcement", message: "first", hours: 24 });
  const sh = ss.getSheetByName("Shoutouts");
  check("Shoutouts tab created on first write", sh !== null);
  const headers = sh.getRange(1, 1, 1, 7).getValues()[0];
  check("headers written", JSON.stringify(headers) ===
    JSON.stringify(["Id", "Type", "Commander", "Message", "Created", "Expires", "Author"]),
    JSON.stringify(headers));
  check("one data row", sh.getLastRow() === 2, "rows=" + sh.getLastRow());
}

/* --- field handling --- */
{
  const { sandbox, ss } = loadCodeGs({ secret: "s" });

  const shout = post(sandbox, ss, {
    secret: "s", type: "shoutout", commander: "피자감자",
    message: "Carried the whole VS", hours: 72, author: "Makpy",
  });
  check("shoutout accepted with a commander", shout.ok === true, JSON.stringify(shout));
  check("expiry is ~72h out", (() => {
    const dt = new Date(shout.expires) - Date.now();
    return Math.abs(dt - 72 * 3600 * 1000) < 5000;
  })(), shout.expires);

  const noName = post(sandbox, ss, { secret: "s", type: "shoutout", message: "great job", hours: 24 });
  check("shoutout without a commander is refused", noName.ok === false, JSON.stringify(noName));

  const noMsg = post(sandbox, ss, { secret: "s", type: "announcement", message: "   ", hours: 24 });
  check("blank message is refused", noMsg.ok === false, JSON.stringify(noMsg));

  const forever = post(sandbox, ss, { secret: "s", type: "announcement", message: "standing notice" });
  check("no hours => blank Expires (until removed)", forever.ok === true && forever.expires === null,
    JSON.stringify(forever));

  const weird = post(sandbox, ss, { secret: "s", type: "nonsense", message: "x", hours: 1 });
  check("unknown type falls back to announcement", weird.type === "announcement", JSON.stringify(weird));

  const negative = post(sandbox, ss, { secret: "s", type: "announcement", message: "x", hours: -5 });
  check("negative hours treated as until-removed", negative.expires === null, JSON.stringify(negative));

  const ids = new Set([shout.id, forever.id, weird.id, negative.id]);
  check("ids are distinct", ids.size === 4, [...ids].join(","));

  // same-millisecond burst: the collision the timestamp-only id used to have
  const burst = [];
  for (let i = 0; i < 200; i++) burst.push(post(sandbox, ss, { secret: "s", type: "announcement", message: "b" + i, hours: 1 }).id);
  check("200 rapid ids are all distinct", new Set(burst).size === 200, "distinct=" + new Set(burst).size);
}

/* --- expiry --- */
{
  const { sandbox, ss } = loadCodeGs({ secret: "s" });
  const made = post(sandbox, ss, { secret: "s", type: "announcement", message: "temp", hours: 168 });

  const unauth = sandbox.expireCallout(ss, { secret: "nope", id: made.id });
  check("expire refuses a wrong secret", unauth.ok === false && unauth.error === "unauthorized");

  const gone = sandbox.expireCallout(ss, { secret: "s", id: made.id });
  check("expire stamps the row", gone.ok === true, JSON.stringify(gone));
  check("stamped time is now-ish", Math.abs(new Date(gone.expires) - Date.now()) < 5000, gone.expires);

  const sh = ss.getSheetByName("Shoutouts");
  const row = sh.getRange(2, 1, 1, 7).getValues()[0];
  check("Expires column actually rewritten", String(row[5]) === gone.expires, JSON.stringify(row));

  const missing = sandbox.expireCallout(ss, { secret: "s", id: "s_does_not_exist" });
  check("unknown id reports not found", missing.ok === false && /not found/.test(missing.error), JSON.stringify(missing));

  const noId = sandbox.expireCallout(ss, { secret: "s" });
  check("missing id is refused", noId.ok === false, JSON.stringify(noId));
}

/* --- the existing snapshot path must keep working without a secret --- */
{
  const { sandbox, ss } = loadCodeGs({ secret: "s" });
  const res = sandbox.doPost({
    postData: { contents: JSON.stringify({ date: "2026-08-02", rank: 5, commander: "워워", tier: "R3", power: 97692715 }) },
  });
  const body = JSON.parse(res.getContent());
  check("insertRow still works with no secret (push.py unaffected)", body.ok === true, res.getContent());

  const routed = sandbox.doPost({
    postData: { contents: JSON.stringify({ action: "callout", secret: "s", type: "announcement", message: "via doPost", hours: 6 }) },
  });
  const rb = JSON.parse(routed.getContent());
  check("doPost routes action=callout to postCallout", rb.ok === true && String(rb.id).startsWith("s_"), routed.getContent());

  const routedBad = sandbox.doPost({
    postData: { contents: JSON.stringify({ action: "callout", secret: "bad", message: "x" }) },
  });
  check("doPost callout with bad secret is refused",
    JSON.parse(routedBad.getContent()).error === "unauthorized", routedBad.getContent());
}

/* --- reading goes through the untouched getData path --- */
{
  const { sandbox, ss } = loadCodeGs({ secret: "s" });
  post(sandbox, ss, { secret: "s", type: "shoutout", commander: "Makpy", message: "nice", hours: 24 });
  const out = sandbox.getData(ss, { sheet: "Shoutouts" });
  check("getData reads the Shoutouts tab", out.count === 1 && out.data[0].Commander === "Makpy", JSON.stringify(out));
  check("Shoutouts has no parsed date (snapshot loaders skip it)", out.date === null, String(out.date));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
