/* =============================================================
   kWcl HQ — service worker

   Exists for one reason: only a service worker can display a push
   notification. It deliberately does NOT cache the site — the HQ page reads
   live data and already has its own localStorage snapshot cache, so an
   offline cache here would only add a second, staler copy and a class of
   "why am I seeing yesterday's numbers" bugs.

   Registered from index.html with a RELATIVE path, so on GitHub Pages the
   scope is /kwcl/ rather than the origin root:
       navigator.serviceWorker.register("sw.js")

   Bump VERSION on every change. Browsers re-check this file, but a bumped
   constant makes "is the new one live?" answerable from DevTools.
   ============================================================= */

const VERSION = "kwcl-sw-1";

/* A push with no data is not supposed to happen — the sender always encrypts a
   payload — but a notification that says nothing at all is worse than a vague
   one, and Chrome penalises a push that shows nothing. */
const FALLBACK = {
  title: "kWcl",
  body: "New shoutout on the alliance board.",
  url: "./#shoutouts",
};

self.addEventListener("install", () => {
  // Take over on the next load rather than the one after it.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* ------------------------------------------------------------ tiny store

   pushsubscriptionchange fires with no page open, so the API URL has to be
   somewhere the worker can reach on its own. The Cache API is the only
   key-value store available here without pulling in IndexedDB boilerplate. */

const KV = "kwcl-kv";

async function kvSet(key, value) {
  const cache = await caches.open(KV);
  await cache.put(new Request("./__kv/" + key), new Response(JSON.stringify(value)));
}

async function kvGet(key) {
  const cache = await caches.open(KV);
  const hit = await cache.match(new Request("./__kv/" + key));
  return hit ? hit.json() : null;
}

/* The page tells the worker where the API lives, so a silent re-subscribe
   later can report itself with no page open to ask. */
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "config") {
    event.waitUntil(kvSet("config", {
      apiUrl: msg.apiUrl || "",
      publicKey: msg.publicKey || "",
    }));
  }
});

/* ------------------------------------------------------------------ push */

self.addEventListener("push", (event) => {
  let data = FALLBACK;
  if (event.data) {
    try {
      data = Object.assign({}, FALLBACK, event.data.json());
    } catch (_) {
      // A non-JSON payload is still better than the fallback text.
      const text = event.data.text();
      if (text) data = Object.assign({}, FALLBACK, { body: text });
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || "assets/crest.png",
    badge: data.badge || "assets/crest.png",
    // Same tag replaces an earlier unread notification instead of stacking.
    // A phone that was off all night should wake to the latest shoutout, not
    // to five of them.
    tag: data.tag || "kwcl-shoutout",
    renotify: true,
    data: { url: data.url || FALLBACK.url },
  };

  // Always show something: a push that displays nothing gets the origin's
  // push permission throttled by Chrome.
  event.waitUntil(self.registration.showNotification(data.title, options));
});

/* --------------------------------------------------------------- click */

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || FALLBACK.url;

  event.waitUntil((async () => {
    const url = new URL(target, self.registration.scope).href;
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    // Focus an HQ tab if one is already open rather than opening a second.
    for (const client of clientList) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        if ("navigate" in client) { try { await client.navigate(url); } catch (_) {} }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

/* ------------------------------------------------- subscription rotation

   Browsers rotate endpoints on their own schedule. Without this the
   subscription dies silently: nothing visibly breaks, the commander simply
   stops receiving anything and never thinks to mention it. */

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const config = await kvGet("config");
    if (!config || !config.apiUrl || !config.publicKey) return;

    const fresh = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToBytes(config.publicKey),
    });

    const body = {
      action: "push_subscribe",
      subscription: fresh.toJSON(),
      // The endpoint the server should replace, so rotation updates a row
      // instead of leaving a dead one behind and adding a new one.
      replaces: (event.oldSubscription && event.oldSubscription.endpoint) || "",
    };

    await fetch(config.apiUrl, {
      method: "POST",
      // text/plain keeps this a CORS "simple request", the same trick
      // admin.js uses — Apps Script cannot answer a preflight.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      credentials: "omit",
    });
  })());
});

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
