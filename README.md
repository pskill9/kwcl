# kWcl — Korea World Class · Alliance HQ

Headquarters page for the **kWcl** Last War: Survival alliance. A static site
(GitHub Pages) that reads daily member-power snapshots from a Google Apps Script
API and shows:

- **Situation board** — total alliance power, 24h/7d deltas, member count, and the alliance power trajectory
- **Movers** — top gainers and decliners over 1d / 7d / 30d / all-time
- **Roster** — full leaderboard with per-member 24h/7d deltas and 30-day sparklines
- **Commander dossier** — individual power and rank trajectory, growth stats
- **Compare** — overlay up to 6 commanders, absolute power or indexed growth %
- **Tier breakdown** — power share and averages by R1–R5

No build step, no dependencies — `index.html` + `styles.css` + `app.js` +
`config.js`.

## Use it for your own alliance

Everything alliance-specific lives in **[`config.js`](config.js)**. Fork this
repo, edit that one file, enable GitHub Pages — done:

```js
window.ALLIANCE_CONFIG = {
  name: "MyAlly",                    // short tag shown in the header
  fullName: "My Alliance",
  localName: "우리 연맹",             // optional native-language name
  game: "Last War: Survival",
  apiUrl: "https://script.google.com/macros/s/YOUR_ID/exec",
  icon: "assets/crest.png",          // your crest, or null to hide
  theme: { accentA: "#cd2e3a", accentB: "#3069c9" },  // section rule colors
  charter: { lead, rules: [{label, value, note}], join },  // or null to hide
  footerMotto: "…",
  strings: { /* heading translations, see below */ },
};
```

**Languages.** Every heading has a built-in English label. To localize one,
add its key to `strings` — either a plain string, or a pair that renders as
"native · ENGLISH":

```js
strings: {
  roster: { local: "서열표", en: "Roster" },   // → 서열표 · ROSTER
  movers: "Bewegungen",                        // → plain replacement
  // any key you omit stays English
}
```

The full key list is in the comment at the bottom of `config.js` and in
`STR_EN` in `app.js`.

## Connecting the data

1. Deploy the Google Apps Script as a **Web app** (Deploy → New deployment →
   Web app, *Execute as: Me*, *Who has access: **Anyone***). Copy the URL that
   looks like `https://script.google.com/macros/s/DEPLOY_ID/exec`.
2. Put it in `config.js` as `apiUrl`.

Without a working `apiUrl` the page shows built-in demo data. Admins can also
override the URL per-browser at `https://…/?setup`, or pass
`?api=<web app url>` once (saved to localStorage).

### API contract

- `GET {BASE}?action=sheets` → `{ count, sheets: [{ name, date, rows, columns }] }`
- `GET {BASE}?action=data&sheet=YYYY-MM-DD` → `{ sheet, date, count, data: [{ Rank, Commander, Tier, Power }] }`

One sheet per day. The site loads up to the 120 most recent snapshots, caches
past days and the hall of fame in localStorage (historical sheets are
immutable), and only refetches the latest day on each visit.

Because Apps Script answers slowly and erratically — measured between 1.5s and
15s per call — a return visit paints the cached snapshot **before** any request
goes out, marks the data pill `◍ SAVED`, and swaps to `● LIVE` when the network
catches up. If the API is unreachable, the saved snapshot stays on screen with
an explanatory banner rather than being replaced by demo numbers.

### Hall of fame (optional)

Add a tab named **`Hall of Fame`** with the columns `Event`, `Week`,
`Commander` — one row per winner — and the site grows a scrollable wall of past
MVPs, newest first, each with the commander's avatar. No tab, no section. Point
`hallOfFameSheet` in `config.js` at a different name if you prefer one.

Format the `Week` column as **plain text** (or type it with a leading
apostrophe). Left as a date, Sheets hands the API a `Date`, which serialises to
UTC and can come back a day earlier than what you typed.

### Shoutouts (optional)

Short, time-limited messages shown in a **Shoutouts** section under the
situation board — either an *announcement* (an event, a reminder) or a
*shoutout* naming a commander and saying why. Each carries a display window and
disappears on its own when it closes. No tab, no section.

Admins post them from **`admin.html`**, which is not linked from the public
site — bookmark it. Templates live in `config.js` under `callouts.templates`
and are only a starting point: picking one prefills the message box, which the
admin then edits.

The password is **not** in the repo. It is a script property, so the browser
never sees it:

1. Apps Script → Project Settings → Script Properties → Add
2. Name `CALLOUT_SECRET`, value = the password admins will type

Until that property is set every callout write is refused, so a fresh
deployment is never briefly open. The check is server-side because this site is
static — anything in `app.js` is readable by every visitor, so a password
checked in the browser would protect nothing.

Rows land in a `Shoutouts` tab (`Id`, `Type`, `Commander`, `Message`,
`Created`, `Expires`, `Author`). "Remove now" stamps `Expires` rather than
deleting, so the history stays readable.

Run `node tools/test-callouts.mjs` to exercise the callout code in `Code.gs`
under fake Google services, and `node tools/mock-api.mjs` to drive the site
locally against an in-memory sheet (`index.html?api=http://localhost:8787`).

### Push notifications (optional)

A bell in the topbar. One tap, no name asked: the browser stores an anonymous
subscription and every subscriber gets the same message. Admins send one by
ticking **Also send a phone notification** when posting a shoutout.

It works with the site closed — that is the whole point of a service worker.
**On iPhone and iPad the page must be installed to the Home Screen first**
(Share → Add to Home Screen); Safari does not allow push from a normal tab, and
before installing, the notification API does not exist at all. The bell detects
this and shows the instructions instead.

**Why the sending is split in two.** Web Push needs ECDSA P-256 signing and
AES-128-GCM encryption. Apps Script has neither. The browser has both — but it
cannot deliver: FCM and Apple answer a CORS preflight with no
`Access-Control-Allow-Origin`, so Chrome, Edge and Safari block the final POST.
(Firefox allows it; one path that works for everyone beats two that each work
for some.) So `admin.html` encrypts and `Code.gs` relays the finished bytes —
server to server, where no preflight applies.

`push/crypto.js` holds all of it and is free of anything environment-specific,
so the same file runs in the browser, in node, and — if you ever want sends
that fire with nobody at a keyboard — in a Cloudflare Worker.

Setup, once:

1. `node push/keys.mjs` — generates a VAPID keypair. **Never rotate it**: the
   public half is baked into every subscription any browser has made, and
   changing it invalidates all of them silently.
2. Public key → `config.js` under `push.publicKey`. It is public by design.
3. Private key → Apps Script → Project Settings → Script Properties:
   `VAPID_PRIVATE`, plus `VAPID_PUBLIC` and `VAPID_SUBJECT` (a `mailto:`).
4. In the Apps Script editor, run **`authorizePush`** once and approve the
   prompt. It exists because `pushRelay` catches its own errors — correct in
   production, but a caught scope error never raises the authorization dialog,
   so the run reports success and nothing is granted.

Two tabs appear on their own: `Push Subs` (one row per device) and a `Pushed`
column on `Shoutouts`. Both are in `PRIVATE_SHEETS`, so `?action=data` refuses
to serve them — subscriptions are the credentials needed to push to somebody's
phone.

**A notification is sent at most once.** `push_claim` stamps the callout under a
script lock before anything goes out, because `postThenVerify` retries a lost
POST — right for a sheet write, wrong for a push that already reached every
phone. The Retry button forces past it deliberately.

Test without deploying anything:

```
node push/test-encrypt.mjs        # encrypt, decrypt, verify the VAPID signature
node tools/test-push-relay.mjs    # the real Code.gs under fake Google services
python3 -m http.server 8080       # then open /push/subscribe-test.html
node tools/push-send.mjs --title "Rally" --body "Gathering point in 10"
```

`push-send.mjs` posts straight to the push service by default, so a first
delivery can be proved with nothing deployed. `--via relay` routes through
`Code.gs` instead, exercising the path the admin panel uses.

**Debug with node, not curl.** A POST to `/exec` redirects to
`script.googleusercontent.com`, and `curl -L` returns a Drive "Page Not Found"
page with a 404 for a request that actually succeeded.

### Commander avatars (optional)

`assets/commanders/index.json` maps commander name → image path, and the roster,
dossier and hall of fame use it. Anyone missing from it gets an identity plate
generated in the browser from their name and your alliance tag, so the page
never shows a blank square. The kWcl images were cropped from in-game ranking
screenshots by the `alliance-snapshot` skill.

## Hosting

Served from GitHub Pages off the `main` branch root. Any push to `main`
redeploys automatically.
