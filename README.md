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

No build step, no dependencies — `index.html` + `styles.css` + `app.js`.

## Connecting the data

The page ships with **demo data** so it renders immediately. To show real
alliance data:

1. Deploy the Google Apps Script as a **Web app** (Deploy → New deployment →
   Web app, *Execute as: Me*, *Who has access: **Anyone***). Copy the URL that
   looks like `https://script.google.com/macros/s/DEPLOY_ID/exec`.
2. On the site, click **⚙ Data source**, paste the URL, hit **Test & save**.
   The URL is stored in that browser's localStorage.

To bake the URL in for everyone (recommended once deployed), set it in
[`app.js`](app.js) instead:

```js
const DEFAULT_API_URL = "https://script.google.com/macros/s/DEPLOY_ID/exec";
```

You can also pass it once via query string: `https://…/kwcl/?api=<web app url>`
(it gets saved to localStorage).

### API contract

- `GET {BASE}?action=sheets` → `{ count, sheets: [{ name, date, rows, columns }] }`
- `GET {BASE}?action=data&sheet=YYYY-MM-DD` → `{ sheet, date, count, data: [{ Rank, Commander, Tier, Power }] }`

One sheet per day. The site loads up to the 120 most recent snapshots, caches
past days in localStorage (historical sheets are immutable), and only refetches
the latest day on each visit.

## Hosting

Served from GitHub Pages off the `main` branch root. Any push to `main`
redeploys automatically.
