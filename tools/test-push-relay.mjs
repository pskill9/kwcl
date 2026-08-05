/**
 * Runs the REAL apps-script/Code.gs relay under node, with fake Google services.
 *
 *   node tools/test-push-relay.mjs
 *
 * Same discipline as tools/test-callouts.mjs — this exercises the file you
 * paste into the Apps Script editor, not a reimplementation of it. UrlFetchApp
 * is faked so the assertions can inspect exactly what would have gone out on
 * the wire: which URLs, which headers survived the allowlist, what the body
 * decoded to.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { buildPush, importVapidPrivateKey, bytesToB64url } from "../push/crypto.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "apps-script", "Code.gs");
const SECRET = "kwcl-test";

/* ------------------------------------------------------------- fakes */

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
        getValue() { return at(row - 1, col - 1); },
      };
    },
    appendRow(row) { grid.push(row.slice()); return sheet; },
    // 1-based and header-inclusive, matching the real API: deleteRow(2) drops
    // the first data row. Getting this off by one silently deletes the headers.
    deleteRow(row) { grid.splice(row - 1, 1); return sheet; },
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

/** Records every outbound request and replies with whatever the test queued. */
function makeUrlFetch() {
  const calls = [];
  let replies = [];
  return {
    calls,
    queue(list) { replies = list.slice(); },
    api: {
      fetchAll(requests) {
        calls.push(requests);
        return requests.map((_, i) => {
          const r = replies[i] || { code: 201, body: "" };
          return {
            getResponseCode: () => r.code,
            getContentText: () => r.body || "",
          };
        });
      },
    },
  };
}

function loadCodeGs(props = {}) {
  const ss = makeSpreadsheet([
    makeSheet("Roster", [["Commander", "Tier"], ["피자감자", "R4"]]),
    makeSheet("2026-08-02", [["Rank", "Commander", "Power"], [1, "Blackcavalier", 131513767]]),
    makeSheet("Admin Log", [["Time", "Event", "Result", "Detail"]]),
  ]);

  const store = new Map(Object.entries({ CALLOUT_SECRET: SECRET, ...props }));
  const fetcher = makeUrlFetch();

  const sandbox = {
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (store.has(k) ? store.get(k) : null) }) },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
    },
    UrlFetchApp: fetcher.api,
    // Real Apps Script serialises claims through this; the fake just has to
    // exist so the code under test runs unchanged.
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      formatDate: (d) => d.toISOString().slice(0, 10),
      // Apps Script returns a byte array (signed); mirror that so the code under
      // test is exercised the same way it will be in production.
      base64DecodeWebSafe: (s) => {
        const pad = "=".repeat((4 - (s.length % 4)) % 4);
        const buf = Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
        return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
      },
      newBlob: (b) => ({ _b: b }),
    },
    Logger: { log: () => {} },
    console, Date, JSON, Number, String, Math, isNaN, URL,
  };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SRC, "utf8"), sandbox, { filename: "Code.gs" });
  return { sandbox, ss, fetcher };
}

/* -------------------------------------------------------------- tests */

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? "  -> " + extra : ""}`); }
}
const eq = (l, a, b) => check(l, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const FCM = "https://fcm.googleapis.com/fcm/send/abc123";

function item(over = {}) {
  return {
    endpoint: FCM,
    headers: { Authorization: "vapid t=a.b.c, k=xyz", "Content-Encoding": "aes128gcm", TTL: "600" },
    bodyB64: "AAAAAAAAAAAAAAAAAAAAAA",
    ...over,
  };
}

console.log("\nCode.gs push relay\n");

/* --- auth ------------------------------------------------------------ */
console.log("authentication");
{
  const { sandbox, ss, fetcher } = loadCodeGs();
  const bad = sandbox.pushRelay(ss, { secret: "wrong", items: [item()] });
  eq("wrong password is refused", bad.error, "unauthorized");
  eq("nothing is sent when refused", fetcher.calls.length, 0);

  const none = sandbox.pushRelay(ss, { items: [item()] });
  eq("missing password is refused", none.error, "unauthorized");
}

/* --- host allowlist -------------------------------------------------- */
console.log("\nhost allowlist");
{
  const { sandbox, ss, fetcher } = loadCodeGs();

  check("FCM allowed", sandbox.pushHostAllowed("https://fcm.googleapis.com/fcm/send/x"));
  check("Mozilla subdomain allowed", sandbox.pushHostAllowed("https://updates.push.services.mozilla.com/wpush/v2/x"));
  check("Apple allowed", sandbox.pushHostAllowed("https://web.push.apple.com/x"));
  check("plain http refused", !sandbox.pushHostAllowed("http://fcm.googleapis.com/fcm/send/x"));
  check("unrelated host refused", !sandbox.pushHostAllowed("https://evil.example.com/x"));
  check("lookalike suffix refused", !sandbox.pushHostAllowed("https://notfcm.googleapis.com.evil.com/x"));
  check("bare suffix refused", !sandbox.pushHostAllowed("https://push.services.mozilla.com.evil.net/x"));

  const out = sandbox.pushRelay(ss, {
    secret: SECRET,
    items: [item({ endpoint: "https://evil.example.com/steal" })],
  });
  eq("a disallowed host never reaches fetchAll", fetcher.calls.length, 0);
  eq("and is reported, not silently dropped", out.results[0].error, "host not allowed");
}

/* --- header handling ------------------------------------------------- */
console.log("\nheaders on the wire");
{
  const { sandbox, ss, fetcher } = loadCodeGs();
  fetcher.queue([{ code: 201 }]);

  sandbox.pushRelay(ss, {
    secret: SECRET,
    items: [item({
      headers: {
        Authorization: "vapid t=a.b.c, k=xyz",
        "Content-Encoding": "aes128gcm",
        TTL: "600",
        Urgency: "high",
        Topic: "kwcl-shoutout",
        "X-Sneaky": "should not survive",
      },
    })],
  });

  const req = fetcher.calls[0][0];
  eq("posts to the endpoint", req.url, FCM);
  eq("method", req.method, "post");
  eq("Content-Encoding survives", req.headers["Content-Encoding"], "aes128gcm");
  eq("Authorization survives", req.headers["Authorization"], "vapid t=a.b.c, k=xyz");
  eq("TTL survives", req.headers["TTL"], "600");
  eq("Urgency survives", req.headers["Urgency"], "high");
  eq("Topic survives", req.headers["Topic"], "kwcl-shoutout");
  check("unlisted headers are dropped", req.headers["X-Sneaky"] === undefined);
  eq("content type", req.contentType, "application/octet-stream");
  check("errors are read, not thrown", req.muteHttpExceptions === true);
  check("redirects are not followed", req.followRedirects === false);
}

/* --- TTL default ----------------------------------------------------- */
console.log("\nTTL");
{
  const { sandbox, ss, fetcher } = loadCodeGs();
  fetcher.queue([{ code: 201 }]);
  sandbox.pushRelay(ss, { secret: SECRET, items: [item({ headers: { Authorization: "vapid t=a.b.c, k=x" } })] });
  // FCM refuses a push with no TTL — proven by probe, so the relay defaults it.
  eq("missing TTL is defaulted, not sent empty", fetcher.calls[0][0].headers["TTL"], "86400");
}

/* --- body round trip through base64url ------------------------------- */
console.log("\nbody integrity");
{
  const { sandbox, ss, fetcher } = loadCodeGs();
  fetcher.queue([{ code: 201 }]);

  // Build a real encrypted push, relay it, and confirm the bytes Apps Script
  // would have posted are byte-identical to what the browser encrypted.
  const uaKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey("raw", uaKeys.publicKey)));
  const auth = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));

  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vapidPub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey)));
  const vapidJwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);

  const built = await buildPush({
    subscription: { endpoint: FCM, keys: { p256dh, auth } },
    payload: JSON.stringify({ title: "Rally", body: "Gathering point in 10" }),
    vapid: {
      subject: "mailto:admin@kwcl.example",
      publicKey: vapidPub,
      signingKey: await importVapidPrivateKey(vapidPub, vapidJwk.d),
    },
    ttl: 600,
  });

  sandbox.pushRelay(ss, {
    secret: SECRET,
    items: [{ endpoint: built.endpoint, headers: built.headers, bodyB64: built.bodyB64 }],
  });

  const posted = fetcher.calls[0][0].payload;
  const asBytes = Uint8Array.from(posted.map((b) => (b < 0 ? b + 256 : b)));
  eq("decoded body length matches", asBytes.length, built.body.length);
  eq("decoded body is byte-identical", bytesToB64url(asBytes), bytesToB64url(built.body));
  eq("real VAPID header passes through", fetcher.calls[0][0].headers["Authorization"], built.headers.Authorization);
}

/* --- status pass-through --------------------------------------------- */
console.log("\nstatus handling");
{
  const { sandbox, ss, fetcher } = loadCodeGs();
  fetcher.queue([
    { code: 201 },
    { code: 410, body: "push subscription has unsubscribed or expired" },
    { code: 429, body: "rate limited" },
  ]);

  const out = sandbox.pushRelay(ss, {
    secret: SECRET,
    items: [
      item({ endpoint: "https://fcm.googleapis.com/fcm/send/one" }),
      item({ endpoint: "https://fcm.googleapis.com/fcm/send/two" }),
      item({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/three" }),
    ],
  });

  eq("counts deliveries", out.sent, 1);
  eq("counts dead subscriptions separately", out.gone, 1);
  eq("reports every item", out.count, 3);
  eq("statuses are verbatim, not collapsed", out.results.map((r) => r.status).join(","), "201,410,429");
  check("a refusal carries the service's explanation", /unsubscribed/.test(out.results[1].body));
  check("a success carries no body", out.results[0].body === undefined);
}

/* --- ordering with a mix of rejected and sent ------------------------ */
console.log("\nresult ordering");
{
  const { sandbox, ss, fetcher } = loadCodeGs();
  fetcher.queue([{ code: 201 }, { code: 201 }]);

  const out = sandbox.pushRelay(ss, {
    secret: SECRET,
    items: [
      item({ endpoint: "https://fcm.googleapis.com/fcm/send/one" }),
      item({ endpoint: "https://evil.example.com/two" }),
      item({ endpoint: "https://fcm.googleapis.com/fcm/send/three" }),
    ],
  });
  // Results must line up with the input, or the caller prunes the wrong row.
  eq("results stay in input order", out.results.map((r) => r.index).join(","), "0,1,2");
  eq("the rejected one keeps its slot", out.results[1].error, "host not allowed");
}

/* --- batch ceiling ---------------------------------------------------- */
console.log("\nlimits");
{
  const { sandbox, ss, fetcher } = loadCodeGs();
  const many = [];
  for (let i = 0; i < 26; i++) many.push(item());
  const out = sandbox.pushRelay(ss, { secret: SECRET, items: many });
  check("an oversized batch is refused", /too many items/.test(out.error || ""));
  eq("and nothing is sent", fetcher.calls.length, 0);

  const big = sandbox.pushRelay(ss, { secret: SECRET, items: [item({ bodyB64: "A".repeat(5000) })] });
  eq("an oversized body is refused", big.results[0].error, "body missing or too large");

  const noAuth = sandbox.pushRelay(ss, { secret: SECRET, items: [item({ headers: { TTL: "60" } })] });
  eq("an item with no Authorization is refused", noAuth.results[0].error, "missing Authorization");
}

/* --- unauthorized scope ---------------------------------------------- */
console.log("\nmissing OAuth scope");
{
  const { sandbox, ss } = loadCodeGs();
  // Reproduce exactly what Apps Script threw before the scope was granted.
  sandbox.UrlFetchApp.fetchAll = () => {
    throw new Error("Exception: You do not have permission to call UrlFetchApp.fetchAll. " +
      "Required permissions: https://www.googleapis.com/auth/script.external_request");
  };

  const out = sandbox.pushRelay(ss, { secret: SECRET, items: [item()] });
  check("a missing scope does not throw out of pushRelay", out.ok === false);
  check("and says what to actually do about it", /run authorizePush\(\)/.test(out.error || ""), out.error);

  const log = ss.getSheetByName("Admin Log")._grid;
  check("logged as an authorization problem", log.some((r) => /not authorized/.test(String(r[3]))));

  // An unrelated failure must not be mislabelled as an auth problem.
  const { sandbox: s2, ss: ss2 } = loadCodeGs();
  s2.UrlFetchApp.fetchAll = () => { throw new Error("Exception: DNS error"); };
  const other = s2.pushRelay(ss2, { secret: SECRET, items: [item()] });
  check("other failures keep their own message", /fetchAll failed/.test(other.error || ""), other.error);
}

/* --- key disclosure endpoint ----------------------------------------- */
console.log("\npush_key");
{
  const { sandbox, ss } = loadCodeGs({ VAPID_PRIVATE: "priv123", VAPID_PUBLIC: "BPub456", VAPID_SUBJECT: "mailto:a@b.c" });
  eq("wrong password gets nothing", sandbox.pushKey(ss, { secret: "no" }).error, "unauthorized");

  const ok = sandbox.pushKey(ss, { secret: SECRET, who: "Makpy" });
  eq("the right password gets the key", ok.privateKey, "priv123");
  eq("and the public half", ok.publicKey, "BPub456");
  eq("and the subject", ok.subject, "mailto:a@b.c");

  const log = ss.getSheetByName("Admin Log")._grid;
  check("every disclosure is logged", log.some((r) => r[1] === "push_key" && r[2] === "ok"));
  check("every refusal is logged too", log.some((r) => r[1] === "push_key" && r[2] === "denied"));

  const { sandbox: s2, ss: ss2 } = loadCodeGs();
  check("unset keys fail closed", /not set/.test(s2.pushKey(ss2, { secret: SECRET }).error));
}

/* --- private tabs stay private --------------------------------------- */
console.log("\nprivate sheets");
{
  const { sandbox, ss } = loadCodeGs();
  ss.insertSheet("Push Subs").appendRow(["Id", "Commander", "Endpoint"]);
  ss._sheets[ss._sheets.length - 1].appendRow(["s1", "피자감자", FCM]);

  const dump = sandbox.getData(ss, { sheet: "Push Subs" });
  check("Push Subs cannot be read", /not found/.test(dump.error || ""), JSON.stringify(dump).slice(0, 80));
  check("Admin Log cannot be read", /not found/.test(sandbox.getData(ss, { sheet: "Admin Log" }).error || ""));
  check("case does not bypass it", /not found/.test(sandbox.getData(ss, { sheet: "push subs" }).error || ""));

  const names = sandbox.listSheets(ss).sheets.map((s) => s.name);
  check("Push Subs is not enumerated", !names.includes("Push Subs"));
  check("Admin Log is not enumerated", !names.includes("Admin Log"));
  check("public tabs still list", names.includes("2026-08-02"));
  check("public tabs still read", sandbox.getData(ss, { sheet: "2026-08-02" }).count === 1);
}

/* --- subscription storage --------------------------------------------- */

const MOZ = "https://updates.push.services.mozilla.com/wpush/v2/abc";
const subFor = (endpoint) => ({
  subscription: { endpoint, keys: { p256dh: "BFuSs90Femq", auth: "wpnVFYWxnhPP" } },
});

console.log("\npush_subscribe");
{
  const { sandbox, ss } = loadCodeGs();

  const a = sandbox.pushSubscribe(ss, subFor(FCM));
  check("a new subscription is created", a.ok && a.created === true, JSON.stringify(a));

  // Re-tapping the bell must never produce a second row for the same device.
  const b = sandbox.pushSubscribe(ss, subFor(FCM));
  check("re-subscribing updates instead of duplicating", b.ok && b.created === false);
  eq("still one row", ss.getSheetByName("Push Subs")._grid.length - 1, 1);

  sandbox.pushSubscribe(ss, subFor(MOZ));
  eq("a different device adds a row", ss.getSheetByName("Push Subs")._grid.length - 1, 2);

  const bad = sandbox.pushSubscribe(ss, subFor("https://evil.example.com/x"));
  check("a non-push host is refused", !bad.ok, JSON.stringify(bad));

  const partial = sandbox.pushSubscribe(ss, { subscription: { endpoint: FCM, keys: {} } });
  check("a subscription missing keys is refused", !partial.ok);

  const long = sandbox.pushSubscribe(ss, subFor("https://fcm.googleapis.com/fcm/send/" + "x".repeat(600)));
  check("an over-long endpoint is refused", !long.ok);
}

console.log("\nsubscription rotation");
{
  const { sandbox, ss } = loadCodeGs();
  sandbox.pushSubscribe(ss, subFor(FCM));
  const rotated = Object.assign(subFor(MOZ), { replaces: FCM });
  sandbox.pushSubscribe(ss, rotated);

  const grid = ss.getSheetByName("Push Subs")._grid;
  eq("rotation replaces rather than accumulates", grid.length - 1, 1);
  check("the new endpoint is the one kept", grid[1].indexOf(MOZ) !== -1);
}

console.log("\npush_unsubscribe");
{
  const { sandbox, ss } = loadCodeGs();
  sandbox.pushSubscribe(ss, subFor(FCM));

  const gone = sandbox.pushUnsubscribe(ss, { endpoint: FCM });
  check("removes the row", gone.ok && gone.removed === true);
  eq("table is empty", ss.getSheetByName("Push Subs")._grid.length - 1, 0);

  const again = sandbox.pushUnsubscribe(ss, { endpoint: FCM });
  check("unsubscribing twice is not an error", again.ok && again.removed === false);
  check("an empty endpoint is refused", !sandbox.pushUnsubscribe(ss, {}).ok);
}

console.log("\npush_list");
{
  const { sandbox, ss } = loadCodeGs();
  sandbox.pushSubscribe(ss, subFor(FCM));
  sandbox.pushSubscribe(ss, subFor(MOZ));

  eq("needs the admin password", sandbox.pushList(ss, { secret: "no" }).error, "unauthorized");

  const list = sandbox.pushList(ss, { secret: SECRET });
  eq("returns both", list.count, 2);
  check("in the shape the sender expects", !!(list.subs[0].endpoint && list.subs[0].keys.p256dh && list.subs[0].keys.auth));
}

console.log("\npush_apply — pruning");
{
  const { sandbox, ss } = loadCodeGs();
  sandbox.pushSubscribe(ss, subFor(FCM));
  sandbox.pushSubscribe(ss, subFor(MOZ));

  const out = sandbox.pushApplyResults(ss, {
    secret: SECRET,
    results: [{ endpoint: FCM, status: 201 }, { endpoint: MOZ, status: 410 }],
  });
  eq("one disabled", out.disabled, 1);
  eq("a dead subscription disappears from the send list", sandbox.pushList(ss, { secret: SECRET }).count, 1);

  // 429 is "slow down", not "broken" — it must not count as a strike.
  const { sandbox: s2, ss: ss2 } = loadCodeGs();
  s2.pushSubscribe(ss2, subFor(FCM));
  for (let i = 0; i < 6; i++) s2.pushApplyResults(ss2, { secret: SECRET, results: [{ endpoint: FCM, status: 429 }] });
  eq("six 429s do not disable a subscription", s2.pushList(ss2, { secret: SECRET }).count, 1);

  // Five unexplained failures do.
  const { sandbox: s3, ss: ss3 } = loadCodeGs();
  s3.pushSubscribe(ss3, subFor(FCM));
  for (let i = 0; i < 5; i++) s3.pushApplyResults(ss3, { secret: SECRET, results: [{ endpoint: FCM, status: 500 }] });
  eq("five 500s do", s3.pushList(ss3, { secret: SECRET }).count, 0);

  // And a re-tap of the bell brings it back.
  s3.pushSubscribe(ss3, subFor(FCM));
  eq("re-subscribing revives a disabled row", s3.pushList(ss3, { secret: SECRET }).count, 1);
}

console.log("\nsubscriptions stay private");
{
  const { sandbox, ss } = loadCodeGs();
  sandbox.pushSubscribe(ss, subFor(FCM));
  check("the tab cannot be read publicly", /not found/.test(sandbox.getData(ss, { sheet: "Push Subs" }).error || ""));
  check("nor enumerated", !sandbox.listSheets(ss).sheets.map((s) => s.name).includes("Push Subs"));
}

/* --- send-once claim ---------------------------------------------------- */
console.log("\npush_claim — the dedup gate");
{
  const { sandbox, ss } = loadCodeGs();
  const posted = sandbox.postCallout(ss, { secret: SECRET, type: "announcement", message: "Rally at 9", hours: 6 });
  check("a callout was posted", posted.ok, JSON.stringify(posted));

  const first = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id });
  check("the first caller may send", first.ok && first.claimed === true);

  // This is the case that matters: postThenVerify retrying a lost response.
  const second = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id });
  check("a second attempt is refused", second.ok && second.claimed === false);
  check("and reports when it was sent", !!second.pushedAt);

  const third = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id });
  check("and stays refused", third.claimed === false);

  const forced = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id, force: true });
  check("the Retry button can force past it", forced.claimed === true);

  eq("needs the admin password", sandbox.pushClaim(ss, { calloutId: posted.id }).error, "unauthorized");
  check("an unknown id is refused", /not found/.test(sandbox.pushClaim(ss, { secret: SECRET, calloutId: "nope" }).error || ""));
  check("a missing id is refused", /required/.test(sandbox.pushClaim(ss, { secret: SECRET }).error || ""));

  // Two different callouts must not block one another.
  const other = sandbox.postCallout(ss, { secret: SECRET, type: "announcement", message: "Different", hours: 6 });
  check("a different callout claims independently",
        sandbox.pushClaim(ss, { secret: SECRET, calloutId: other.id }).claimed === true);
}

console.log("\nPushed column");
{
  const { sandbox, ss } = loadCodeGs();
  const posted = sandbox.postCallout(ss, { secret: SECRET, type: "announcement", message: "x", hours: 1 });
  const sh = ss.getSheetByName("Shoutouts");
  const headers = sh._grid[0];
  check("Shoutouts has a Pushed column", headers.includes("Pushed"));

  const col = headers.indexOf("Pushed");
  check("a fresh callout is unstamped", !String(sh._grid[1][col] || "").trim());
  sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id });
  check("claiming stamps it", !!String(sh._grid[1][col] || "").trim());

  // The public site reads this tab; a new column must not disturb it.
  const shown = sandbox.getData(ss, { sheet: "Shoutouts" });
  eq("the site still reads the tab", shown.count, 1);
  eq("and still sees the message", shown.data[0].Message, "x");
}

console.log("\nPushed column added to an existing tab");
{
  // Reproduces the live failure: a Shoutouts tab that predates the Pushed
  // column. Claiming must add the column rather than refuse.
  const { sandbox, ss } = loadCodeGs();
  const legacy = ss.insertSheet("Shoutouts");
  legacy._grid.push(["Id", "Type", "Commander", "Badge", "Message", "Created", "Expires", "Author"]);
  legacy._grid.push(["s_old_1", "announcement", "", "", "Older callout", new Date().toISOString(), "", ""]);

  check("the tab starts without a Pushed column", !legacy._grid[0].includes("Pushed"));
  const claim = sandbox.pushClaim(ss, { secret: SECRET, calloutId: "s_old_1" });
  check("claiming still works", claim.ok && claim.claimed === true, JSON.stringify(claim));
  check("and the column was added", legacy._grid[0].includes("Pushed"));
  check("a second claim is refused", sandbox.pushClaim(ss, { secret: SECRET, calloutId: "s_old_1" }).claimed === false);
}

console.log("\nclaim is idempotent for its own retry");
{
  // This is the bug that lost a real notification: pushPost retries a lost
  // POST, attempt 1 stamped the row and its reply vanished, attempt 2 was told
  // "already sent", and nothing went out at all.
  const { sandbox, ss } = loadCodeGs();
  const posted = sandbox.postCallout(ss, { secret: SECRET, type: "announcement", message: "Rally", hours: 6 });
  const tok = "tok-abc";

  const a = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id, token: tok });
  check("first attempt claims", a.claimed === true && !a.repeat);

  const b = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id, token: tok });
  check("the SAME token still claims (a retry, not a duplicate)", b.claimed === true, JSON.stringify(b));
  check("and is marked as a repeat", b.repeat === true);
  eq("keeping the original timestamp", b.pushedAt, a.pushedAt);

  const c = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id, token: "tok-different" });
  check("a DIFFERENT token is refused", c.claimed === false, JSON.stringify(c));

  const d = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id });
  check("no token at all is refused", d.claimed === false);

  const e = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id, token: "tok-retry-button", force: true });
  check("Retry still forces through", e.claimed === true);

  const f = sandbox.pushClaim(ss, { secret: SECRET, calloutId: posted.id, token: "tok-abc" });
  check("the old token no longer claims once another send took over", f.claimed === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
