/**
 * Proves the Web Push crypto offline — no account, no network, no push
 * service, no deployed anything.
 *
 *   node push/test-encrypt.mjs
 *
 * It encrypts exactly the way the admin browser will, then decrypts the way a
 * real browser would, and checks the VAPID signature the way a push service
 * would. If this passes, the only thing left that can be wrong is transport.
 *
 * Same discipline as tools/test-callouts.mjs: exercise the real module, never
 * a reimplementation of it.
 */
import {
  encryptPayload, decryptPayload, signVapid, audienceFor,
  importVapidPrivateKey, bytesToB64url, b64urlToBytes, MAX_PAYLOAD_BYTES,
} from "./crypto.js";

let passed = 0, failed = 0;

function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/* ---------------------------------------------------- fake subscriber */

/** Stand in for a browser: an ECDH keypair plus a 16-byte auth secret. */
async function makeFakeSubscription(endpoint) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keyPair: keys,
    authB64: bytesToB64url(auth),
    subscription: {
      endpoint,
      keys: { p256dh: bytesToB64url(p256dh), auth: bytesToB64url(auth) },
    },
  };
}

async function makeVapid() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: bytesToB64url(raw), privateKey: jwk.d, verifyKey: pair.publicKey };
}

/* ------------------------------------------------------------- tests */

console.log("\npush/crypto.js\n");

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/cZmFkZUV4YW1wbGU";
const fake = await makeFakeSubscription(ENDPOINT);
const vapid = await makeVapid();

/* --- 1. round trip --------------------------------------------------- */
console.log("encryption round trip");
{
  const message = JSON.stringify({
    title: "Shoutout: 피자감자",
    body: "Carried the whole VS — 7.4M points",
    url: "./#shoutouts",
  });

  const body = await encryptPayload(fake.subscription, message);
  const back = await decryptPayload(body, fake.keyPair, fake.authB64);

  eq("decrypts to the original payload", back, message);
  check("non-ascii survives", JSON.parse(back).title.includes("피자감자"));
}

/* --- 2. record framing (RFC 8188 §2.1) ------------------------------- */
console.log("\nrecord framing");
{
  const body = await encryptPayload(fake.subscription, "x");
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16, false);

  eq("record size field", rs, 4096);
  eq("key id length field", body[20], 65);
  eq("key id is an uncompressed point", body[21], 0x04);
  // 16 salt + 4 rs + 1 idlen + 65 key + (1 byte plaintext + 1 delimiter + 16 tag)
  eq("total body length", body.length, 16 + 4 + 1 + 65 + 18);
}

/* --- 3. every encryption is unique ----------------------------------- */
console.log("\nnonce reuse");
{
  const a = await encryptPayload(fake.subscription, "same message");
  const b = await encryptPayload(fake.subscription, "same message");
  const saltA = bytesToB64url(a.slice(0, 16));
  const saltB = bytesToB64url(b.slice(0, 16));
  check("salt differs between sends", saltA !== saltB);
  check("ciphertext differs between sends", bytesToB64url(a) !== bytesToB64url(b));
}

/* --- 4. wrong keys must not decrypt ---------------------------------- */
console.log("\nwrong recipient");
{
  const other = await makeFakeSubscription(ENDPOINT);
  const body = await encryptPayload(fake.subscription, "for the first subscriber only");
  let threw = false;
  try {
    await decryptPayload(body, other.keyPair, other.authB64);
  } catch { threw = true; }
  check("a different subscriber cannot decrypt", threw);
}

/* --- 5. size ceiling -------------------------------------------------- */
console.log("\npayload ceiling");
{
  eq("limit matches RFC framing", MAX_PAYLOAD_BYTES, 3993);

  const atLimit = "a".repeat(MAX_PAYLOAD_BYTES);
  const body = await encryptPayload(fake.subscription, atLimit);
  eq("a payload at the limit fits in one record", body.length, 4096);

  let threw = false;
  try { await encryptPayload(fake.subscription, "a".repeat(MAX_PAYLOAD_BYTES + 1)); }
  catch { threw = true; }
  check("one byte over is refused", threw);
}

/* --- 6. VAPID -------------------------------------------------------- */
console.log("\nVAPID signing");
{
  const signingKey = await importVapidPrivateKey(vapid.publicKey, vapid.privateKey);
  const { jwt, header } = await signVapid({
    audience: audienceFor(ENDPOINT),
    subject: "mailto:admin@kwcl.example",
    publicKey: vapid.publicKey,
    signingKey,
  });

  eq("audience is the origin, not the endpoint", audienceFor(ENDPOINT), "https://fcm.googleapis.com");

  const [h, p, s] = jwt.split(".");
  const head = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));

  eq("alg", head.alg, "ES256");
  eq("typ", head.typ, "JWT");
  eq("aud", claims.aud, "https://fcm.googleapis.com");
  eq("sub", claims.sub, "mailto:admin@kwcl.example");
  check("exp is in the future", claims.exp > Math.floor(Date.now() / 1000));
  check("exp is within 24h", claims.exp - Math.floor(Date.now() / 1000) <= 86400);

  // A raw r||s signature is 64 bytes; a DER one would not be, and would be rejected.
  eq("signature is raw r||s", b64urlToBytes(s).length, 64);

  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    vapid.verifyKey,
    b64urlToBytes(s),
    new TextEncoder().encode(h + "." + p)
  );
  check("signature verifies against the public key", verified);

  check("Authorization header shape", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(header), header.slice(0, 60));
  check("header carries the same public key the client subscribes with", header.endsWith(", k=" + vapid.publicKey));
}

/* --------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
