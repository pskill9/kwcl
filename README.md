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
past days in localStorage (historical sheets are immutable), and only refetches
the latest day on each visit.

## Hosting

Served from GitHub Pages off the `main` branch root. Any push to `main`
redeploys automatically.
