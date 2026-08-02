# Callouts / Shoutouts — design

**Date:** 2026-08-02
**Status:** approved

Admins post short, time-limited messages that appear in a Shoutouts section on
the alliance page. Two kinds: **announcements** (an event, a reminder) and
**shoutouts** (praising a named commander and saying why). Each carries a
display window and disappears on its own when that window closes.

## Why the password has to be server-side

The site is static and served from GitHub Pages, and `app.js` is public. A
password checked in the browser is a speed bump: anyone can read the check, or
skip the page and POST directly. So the secret lives in Apps Script Properties
(`CALLOUT_SECRET`), which the browser never sees, and `Code.gs` refuses any
callout write that does not present it.

The secret is required for **callout writes only**. The existing `insertRow`
path stays open, because `push.py` (the daily snapshot) posts to it with no
credentials. Closing that is a separate change that has to update the snapshot
scripts in the same breath.

Callout writes go over **POST**, so the secret stays out of URL query logs.

## Data model

A tab named `Shoutouts` (overridable via `config.callouts.sheet`):

| Column | Meaning |
|---|---|
| `Id` | `s_<epoch-ms>` — lets a specific callout be removed early |
| `Type` | `announcement` or `shoutout` |
| `Commander` | target of a shoutout; blank for announcements |
| `Message` | the body text |
| `Created` | ISO datetime, set server-side |
| `Expires` | ISO datetime, or blank meaning "until removed" |
| `Author` | who posted it (free text, optional) |

The name carries no date, so `parseDateFromName` returns null and both the
snapshot loader and `?action=all` skip the tab already — the same reason the
`Hall of Fame` tab has never interfered.

## Reading needs no Code.gs change

The site fetches `?action=data&sheet=Shoutouts` through the existing `getData`,
exactly as `loadHallOfFame` does. Only writing is new.

## Code.gs changes

1. `doPost` routes on `action`: `callout` and `callout_expire` go to the new
   handlers; everything else falls through to `insertRow` **unchanged**.
2. `postCallout(ss, params)` — verify secret, append a row, creating the tab
   and headers if absent.
3. `expireCallout(ss, params)` — verify secret, stamp `Expires` = now for a
   given `Id`. This is the "remove now" button.
4. `calloutSecretOk(provided)` — compares against the `CALLOUT_SECRET` script
   property. **Fails closed:** if the property is unset or empty, every callout
   write is refused, so a fresh deployment is never briefly open.

Error replies are `{ok:false, error:"unauthorized"}` and never echo the secret.

## Public site

A `<section id="shoutouts">` directly under the situation board — these are the
most perishable items on the page, so they sit above the charter.

`loadShoutouts(base)` joins the existing `Promise.all` beside `loadHallOfFame`
and never rejects; a missing tab, an empty tab, or a fork that never made one
all end the same way, with the section hidden.

**Active** means `Expires` is blank, or parses to a time in the future.
Filtering happens at render, so a cached-but-since-expired callout drops
silently instead of flashing on a return visit. An `Expires` value that cannot
be parsed is treated as **expired** — a bad row disappears rather than sticking
to the front page forever.

Shoutout cards show the commander's avatar from `assets/commanders` (falling
back to the generated identity plate, as elsewhere). Announcement cards show a
message with no avatar.

## Admin page

`admin.html` + `admin.js`, standalone and unlinked from the public site, so the
admin markup and logic are not shipped to every visitor and `app.js` (already
~1,600 lines) does not grow.

- Password field, held in `sessionStorage` — cleared when the tab closes.
- Type toggle: announcement / shoutout.
- Template picker that **prefills an editable message**; templates are strings
  in `config.js` and can be reworded without touching code.
- Commander input backed by a datalist of current Roster names, **free text
  still accepted** so non-members and group shoutouts work.
- Duration presets: 6h / 24h / 3 days / 1 week / until removed.
- Live preview of the card as it will render.
- Below the form, the currently-active list with **Remove now** on each.

## Templates (config.js)

```js
callouts: {
  sheet: "Shoutouts",
  templates: [
    { type: "announcement", label: "Event announcement", text: "…" },
    { type: "shoutout",     label: "Great performance",  text: "…" },
  ],
}
```

## Testing

Two layers, because exercising a mock proves nothing about the code that gets
pasted into Apps Script:

1. **Shim harness** — fake `SpreadsheetApp`, `PropertiesService`,
   `ContentService` and `Utilities` so the *real* `Code.gs` runs under node.
   Covers: correct secret, wrong secret, missing secret, unset property,
   tab auto-creation, header creation, early expiry, unknown id.
2. **Local end-to-end** — a mock API plus a static server, driving
   `admin.html` and `index.html` via `?api=http://localhost:…`, confirming the
   round trip: rejected password, post appears, expired one vanishes, remove
   works.

Neither touches the live sheet or the deployed script.

## Out of scope

- Locking down the existing `insertRow` path (needs `push.py` updated too).
- Editing a posted callout — remove and repost instead.
- Per-admin accounts or an audit trail beyond the free-text `Author` field.
