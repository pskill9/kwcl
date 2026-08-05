/**
 * Generate a VAPID keypair. No npm, no web-push dependency — the output is
 * byte-identical in format to `npx web-push generate-vapid-keys`.
 *
 *   node push/keys.mjs
 *
 * Run this ONCE. The public key goes in config.js (it is public by design and
 * ships to every visitor). The private key goes in the Apps Script property
 * VAPID_PRIVATE and nowhere else.
 *
 * Never rotate the pair. The public half is baked into every subscription any
 * browser has ever minted for the site; changing it silently invalidates all
 * of them, with no error surfaced anywhere.
 */
import { bytesToB64url } from "./crypto.js";

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
);

const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

console.log("Public key  (config.js, public):");
console.log("  " + bytesToB64url(raw));
console.log("");
console.log("Private key (Script Property VAPID_PRIVATE, secret):");
console.log("  " + jwk.d);
console.log("");
console.log("Subject     (Script Property VAPID_SUBJECT):");
console.log("  mailto:you@example.com");
