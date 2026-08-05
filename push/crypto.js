/**
 * Web Push encryption and VAPID signing — the whole of the crypto, in one file.
 *
 * Deliberately free of anything environment-specific: no fetch, no DOM, no
 * Apps Script, no node imports. It takes bytes and returns bytes, and the
 * caller does the transport. That is what lets the identical file run in
 *
 *   - the admin browser        (Design R — admin.js)
 *   - node                     (tools/push-send.mjs)
 *   - a Cloudflare Worker      (Design W — push/worker.js)
 *
 * All three have the same `crypto.subtle`, so none of this changes if the
 * relay is later swapped for a Worker.
 *
 * References:
 *   RFC 8188 — aes128gcm content encoding
 *   RFC 8291 — Message Encryption for Web Push
 *   RFC 8292 — VAPID
 */

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

/* ------------------------------------------------------------ base64url */

export function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  const b = new Uint8Array(bytes);
  /* String.fromCharCode(...b) blows the call stack on large payloads, and a
     4 KB push record is big enough to matter on some engines. */
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------------------------------------------------------------- bytes */

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function uint32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

/* ------------------------------------------------------------------ ecc */

/** Raw 65-byte uncompressed P-256 point -> the x and y halves. */
function splitPoint(raw) {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("expected a 65-byte uncompressed P-256 point");
  }
  return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

/**
 * Build a signing key from the pair `web-push generate-vapid-keys` prints.
 *
 * That tool hands you two base64url strings and WebCrypto wants a JWK, so the
 * x and y coordinates have to be sliced back out of the public point. This is
 * the step that costs an hour if nobody wrote it down.
 */
export async function importVapidPrivateKey(publicKeyB64url, privateKeyB64url) {
  const { x, y } = splitPoint(b64urlToBytes(publicKeyB64url));
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(x),
    y: bytesToB64url(y),
    d: privateKeyB64url.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
    ext: true,
  };
  return subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/* ---------------------------------------------------------------- vapid */

/**
 * A signed VAPID JWT for one push-service origin.
 *
 * `aud` is the ORIGIN of the endpoint, never the full endpoint URL — push
 * services reject the latter. Sign once per origin and reuse: a 100-person
 * broadcast touches two or three services, so that is three signatures, not
 * a hundred.
 */
export async function signVapid({ audience, subject, publicKey, signingKey, expiresInSeconds = 12 * 3600, now = null }) {
  const iat = Math.floor((now === null ? Date.now() : now) / 1000);
  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: audience, exp: iat + expiresInSeconds, sub: subject };

  const signingInput =
    bytesToB64url(enc.encode(JSON.stringify(header))) + "." +
    bytesToB64url(enc.encode(JSON.stringify(claims)));

  /* WebCrypto emits ECDSA signatures as raw r||s (IEEE P1363), which is
     exactly what JWS ES256 wants — no DER unwrapping needed. */
  const sig = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    enc.encode(signingInput)
  );

  const jwt = signingInput + "." + bytesToB64url(new Uint8Array(sig));
  return { jwt, header: `vapid t=${jwt}, k=${publicKey}` };
}

/** The origin of an endpoint, which is what `aud` must be. */
export function audienceFor(endpoint) {
  const u = new URL(endpoint);
  return u.origin;
}

/* ------------------------------------------------------- key derivation */

async function hkdf(salt, ikm, info, lengthBytes) {
  const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    base,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

/** The shared half of encrypt/decrypt: everything from the ECDH secret down. */
async function deriveKeys({ ecdhSecret, authSecret, salt, uaPublic, asPublic }) {
  // RFC 8291 §3.4 — the auth secret is the salt for the IKM step.
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const cekBytes = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const cek = await subtle.importKey("raw", cekBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { cek, nonce };
}

/* -------------------------------------------------------------- payload */

/** 86-byte aes128gcm header + 16-byte GCM tag + the 1-byte record delimiter. */
export const MAX_PAYLOAD_BYTES = 4096 - 86 - 16 - 1;   // 3993

/**
 * Encrypt one payload for one subscriber.
 *
 * `subscription` is the shape `PushSubscription.toJSON()` produces, so it can
 * be handed straight from the browser to here with no reshaping:
 *   { endpoint, keys: { p256dh, auth } }
 *
 * Returns the request body bytes. Caller POSTs them with
 *   Content-Encoding: aes128gcm
 *   Authorization: <the header from signVapid>
 *   TTL: <seconds>
 */
export async function encryptPayload(subscription, payloadText, opts = {}) {
  const payload = typeof payloadText === "string" ? enc.encode(payloadText) : payloadText;
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload is ${payload.length} bytes, limit is ${MAX_PAYLOAD_BYTES}`);
  }

  const uaPublic = b64urlToBytes(subscription.keys.p256dh);
  const authSecret = b64urlToBytes(subscription.keys.auth);
  const salt = opts.salt || globalThis.crypto.getRandomValues(new Uint8Array(16));

  /* A fresh ephemeral pair per message. Reusing one across a broadcast is
     permitted and saves keygen, but the saving is not worth thinking about
     the forward-secrecy question every time someone reads this. */
  const ephemeral = opts.ephemeralKeyPair || await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const asPublic = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));

  const uaKey = await subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const ecdhSecret = new Uint8Array(await subtle.deriveBits(
    { name: "ECDH", public: uaKey }, ephemeral.privateKey, 256
  ));

  const { cek, nonce } = await deriveKeys({ ecdhSecret, authSecret, salt, uaPublic, asPublic });

  // 0x02 marks the last record. There is only ever one record here.
  const plaintext = concat(payload, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, cek, plaintext
  ));

  // RFC 8188 §2.1 — salt | record size | key id length | key id | ciphertext
  return concat(salt, uint32be(4096), new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/**
 * Decrypt a body the way a browser would. Not used in production — this is
 * what makes the encryption testable offline, with no account, no network and
 * no push service involved.
 */
export async function decryptPayload(body, uaKeyPair, authSecretB64url) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);

  const uaPublic = new Uint8Array(await subtle.exportKey("raw", uaKeyPair.publicKey));
  const asKey = await subtle.importKey(
    "raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const ecdhSecret = new Uint8Array(await subtle.deriveBits(
    { name: "ECDH", public: asKey }, uaKeyPair.privateKey, 256
  ));

  const { cek, nonce } = await deriveKeys({
    ecdhSecret,
    authSecret: b64urlToBytes(authSecretB64url),
    salt, uaPublic, asPublic,
  });

  const plain = new Uint8Array(await subtle.decrypt(
    { name: "AES-GCM", iv: nonce }, cek, ciphertext
  ));

  // Strip the record delimiter and any padding that followed it.
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0x00) end--;
  if (end > 0 && plain[end - 1] === 0x02) end--;
  return new TextDecoder().decode(plain.slice(0, end));
}

/**
 * Everything one subscriber needs, ready to transport.
 *
 * The relay (Code.gs) and the Worker both consume exactly this shape, which is
 * why moving between them touches no crypto.
 */
export async function buildPush({ subscription, payload, vapid, ttl = 86400, urgency = "normal", topic = null }) {
  const body = await encryptPayload(subscription, payload);
  const { header } = await signVapid({
    audience: audienceFor(subscription.endpoint),
    subject: vapid.subject,
    publicKey: vapid.publicKey,
    signingKey: vapid.signingKey,
  });

  const headers = {
    Authorization: header,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: urgency,
  };
  if (topic) headers.Topic = topic;

  return { endpoint: subscription.endpoint, headers, body, bodyB64: bytesToB64url(body) };
}
