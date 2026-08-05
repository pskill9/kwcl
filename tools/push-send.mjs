/**
 * Send a push from the command line.
 *
 *   node tools/push-send.mjs --title "Rally" --body "Gathering point in 10"
 *
 * Two routes to the same push service, chosen with --via:
 *
 *   direct  (default)  node posts straight to FCM / Mozilla / Apple.
 *                      No Apps Script, no deployment, nothing in production
 *                      touched. Works because node has no same-origin policy,
 *                      so the CORS preflight that blocks a browser never
 *                      happens. This is the route for proving delivery.
 *
 *   relay              node encrypts, then hands the bytes to Code.gs's
 *                      push_relay to post. Exercises the exact path the admin
 *                      panel will use, and needs the new Code.gs deployed.
 *
 * The encryption is identical either way — push/crypto.js does not know or
 * care which transport is used.
 *
 * CREDENTIALS, in precedence order:
 *   --vapid <file>            a JSON file  { publicKey, privateKey, subject }
 *   push/.vapid.json          the same, picked up automatically (gitignored)
 *   VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT in the environment
 *
 * SUBSCRIPTION:
 *   --sub <file>              defaults to push/subscription.json, which is
 *                             what the test bench downloads.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { buildPush, importVapidPrivateKey, audienceFor } from "../push/crypto.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { via: "direct" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
  process.exit(0);
}

const TITLE = args.title || "kWcl";
const BODY = args.body || args.message || "Test push from the command line.";
const URL_TARGET = args.url || "./#shoutouts";
const TTL = Number(args.ttl || 3600);
const URGENCY = args.urgency || "normal";

/* ----------------------------------------------------------- credentials */

function loadVapid() {
  const file = args.vapid ? resolve(String(args.vapid)) : join(root, "push", ".vapid.json");
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j.publicKey && j.privateKey) return { ...j, _from: file };
  }
  const { VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT } = process.env;
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    return {
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: VAPID_SUBJECT || "mailto:admin@example.com",
      _from: "environment",
    };
  }
  die(
    "No VAPID keys found.\n" +
    "  Create push/.vapid.json:  { \"publicKey\": \"B…\", \"privateKey\": \"…\", \"subject\": \"mailto:you@example.com\" }\n" +
    "  or run: node push/keys.mjs   to generate a fresh pair."
  );
}

function loadSubscription() {
  const file = args.sub ? resolve(String(args.sub)) : join(root, "push", "subscription.json");
  if (!existsSync(file)) {
    die(
      `No subscription at ${file}\n` +
      "  Serve the repo root over localhost and use the test bench:\n" +
      "    python3 -m http.server 8080\n" +
      "    open http://localhost:8080/push/subscribe-test.html\n" +
      "  Subscribe, then download the JSON to push/subscription.json."
    );
  }
  const sub = JSON.parse(readFileSync(file, "utf8"));
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    die(`${file} is not a PushSubscription — expected { endpoint, keys: { p256dh, auth } }`);
  }
  return { sub, _from: file };
}

function die(msg) {
  console.error("\n" + msg + "\n");
  process.exit(1);
}

/* -------------------------------------------------------------- transport */

/* A note for whoever tries to reproduce a relay call by hand: `curl -L` does
   NOT work against /exec. A POST there 302s to script.googleusercontent.com,
   and curl's redirect handling returns a Drive "Page Not Found" HTML page with
   a 404 for a request that actually succeeded on the server. node's fetch and
   browsers both follow it correctly. Debug with node, not curl. */

async function sendDirect(built) {
  const res = await fetch(built.endpoint, {
    method: "POST",
    headers: built.headers,
    body: built.body,
  });
  return { status: res.status, body: res.status >= 300 ? await res.text() : "" };
}

async function sendViaRelay(built) {
  const api = args.api || readApiUrlFromConfig();
  if (!api) die("No API URL. Pass --api <web app url>, or set apiUrl in config.js.");
  const secret = args.secret || process.env.CALLOUT_SECRET;
  if (!secret) die("The relay needs the admin password. Pass --secret <password>.");

  const payload = JSON.stringify({
    action: "push_relay",
    secret,
    items: [{ endpoint: built.endpoint, headers: built.headers, bodyB64: built.bodyB64 }],
  });

  /* Apps Script loses POSTs. Two distinct ways, both seen in practice:
       - the response comes back as HTML with a 404, or
       - the redirect degrades into a plain GET, so doPost never runs and the
         reply is doGet's default output — the first sheet, as JSON.
     The second is the nastier one: it IS valid JSON, so a naive check reads it
     as a refusal and prints a hundred kilobytes of roster.

     A genuine relay reply always carries `results`. Anything else means the
     request never reached doPost, so it is worth asking again.

     Retrying can in principle double-send if the FIRST attempt delivered and
     only its response was lost. Accepted deliberately: a duplicate
     notification is a smaller failure than a silent one. */
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: payload,
      redirect: "follow",
    });
    const text = await res.text();

    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* HTML error page */ }

    if (json && Array.isArray(json.results)) {
      if (!json.ok) die("Relay refused: " + (json.error || "unknown"));
      const r = json.results[0];
      return { status: r.status, body: r.body || "", relay: json };
    }
    if (json && json.ok === false && json.error) {
      die("Relay refused: " + json.error);   // a real answer; do not retry it
    }

    last = json && json.sheet
      ? `the POST degraded to a GET — got the "${json.sheet}" sheet back instead`
      : /Page Not Found|unable to open the file/i.test(text)
        ? "Google returned its \"no such deployment\" page"
        : `HTTP ${res.status}, unrecognised reply`;

    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }

  die(
    `The relay never answered properly after 3 attempts.\n` +
    `  last: ${last}\n` +
    `  posted to: ${api}\n` +
    `  Check that URL is the deployed web app:  curl -sL "${api}?action=sheets" | head -3`
  );
}

/**
 * Pull apiUrl out of config.js.
 *
 * Comments must be stripped first. config.js opens with a long documentation
 * block containing a worked example — including a placeholder
 * `apiUrl: ".../s/YOUR_ID/exec"` — so a naive match takes the placeholder,
 * posts to a deployment that does not exist, and gets back a Google "Page Not
 * Found" HTML page. Which reads exactly like "your code isn't deployed", and
 * sends you off debugging the wrong thing entirely.
 */
function readApiUrlFromConfig() {
  try {
    const src = readFileSync(join(root, "config.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/^\s*\/\/.*$/gm, "");      // line comments
    const m = src.match(/apiUrl:\s*"([^"]+)"/);
    const url = m ? m[1] : "";
    if (/YOUR_ID|<.*>/.test(url)) return "";   // still a placeholder: refuse it
    return url;
  } catch { return ""; }
}

/* ------------------------------------------------------------------ main */

const vapid = loadVapid();
const { sub, _from: subFrom } = loadSubscription();

const payload = JSON.stringify({ title: TITLE, body: BODY, url: URL_TARGET });

const built = await buildPush({
  subscription: sub,
  payload,
  vapid: {
    subject: vapid.subject || "mailto:admin@example.com",
    publicKey: vapid.publicKey,
    signingKey: await importVapidPrivateKey(vapid.publicKey, vapid.privateKey),
  },
  ttl: TTL,
  urgency: URGENCY,
});

console.log("");
console.log("  keys          " + vapid._from);
console.log("  subscription  " + subFrom);
console.log("  push service  " + audienceFor(sub.endpoint));
console.log("  payload       " + payload.length + " bytes -> " + built.body.length + " encrypted");
console.log("  route         " + (args.via === "relay" ? "via Code.gs relay" : "direct from node"));
console.log("");

const result = args.via === "relay" ? await sendViaRelay(built) : await sendDirect(built);

/* 201 is the norm; 200 happens too. Anything else, say what it means rather
   than printing a bare number and leaving the reader to look it up. */
const meaning = {
  200: "accepted",
  201: "accepted — the notification should be on the device",
  400: "malformed request — check headers",
  401: "VAPID rejected — wrong key or a bad JWT",
  403: "VAPID key does not match the one this subscription was created with",
  404: "subscription is gone — prune it",
  410: "subscription has expired or been unsubscribed — prune it",
  413: "payload too large",
  429: "rate limited — back off",
}[result.status] || "unexpected";

const good = result.status >= 200 && result.status < 300;
console.log(`  ${good ? "OK  " : "FAIL"}  HTTP ${result.status} — ${meaning}`);
if (result.body) console.log("        " + result.body.trim().slice(0, 300));
console.log("");

process.exit(good ? 0 : 1);
