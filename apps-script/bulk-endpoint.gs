/**
 * ?action=all — one request for every dated tab.
 * ---------------------------------------------------------------------------
 * Paste this into the sheet's Apps Script project (alongside doGet/getData),
 * add the routing line shown below to doGet, then Deploy -> Manage deployments
 * -> edit -> New version -> Deploy.
 *
 * In doGet, next to the existing 'sheets' and 'insert' branches:
 *
 *     if (action === 'all') {
 *       return jsonResponse(getAll(ss, params));
 *     }
 *
 * WHY THIS EXISTS
 * The site used to make one request per day plus one to list the tabs. Apps
 * Script answers in 1.5-15s per call regardless of payload size, and the tab
 * list had to return before any day could be fetched, so a cold load spent
 * ~6.7s in two serial waves. This collapses that to a single call.
 *
 * The response is columnar — each commander appears once with an array of
 * values per date — because a per-day response repeats all ~100 names on every
 * single day. Over 120 days that is ~1.7MB of mostly duplicated names; this
 * shape is roughly a tenth of it.
 *
 * PARAMS
 *   since=YYYY-MM-DD  only tabs on or after this date (INCLUSIVE, so the
 *                     caller's newest cached day comes back refreshed)
 *   limit=120         keep only the most recent N tabs after filtering
 *
 * SHAPE
 *   {
 *     count: 5,
 *     dates: ["2026-07-23", ...],                       // ascending
 *     members: [ { name, tier, power: [...], rank: [...] } ]   // null per absent day
 *   }
 *
 * Undated tabs (Roster, Hall of Fame) are skipped: parseDateFromName returns
 * null for them, which is the same rule the daily snapshot loader already uses.
 */
function getAll(ss, params) {
  var since = params.since ? String(params.since).trim() : null;
  var limit = params.limit ? Number(params.limit) : 0;

  var dated = [];
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var d = parseDateFromName(sheets[i].getName());
    if (!d) continue;                       // Roster, Hall of Fame, scratch tabs
    if (since && d < since) continue;       // ISO dates compare correctly as strings
    dated.push({ sheet: sheets[i], date: d });
  }
  dated.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  if (limit > 0 && dated.length > limit) dated = dated.slice(dated.length - limit);

  var dates = dated.map(function (o) { return o.date; });
  var byName = {};

  for (var di = 0; di < dated.length; di++) {
    var values = dated[di].sheet.getDataRange().getValues();
    if (values.length < 2) continue;

    var headers = values[0].map(function (h) { return String(h).trim(); });
    var iName = headers.indexOf('Commander');
    var iPower = headers.indexOf('Power');
    var iRank = headers.indexOf('Rank');
    var iTier = headers.indexOf('Tier');
    if (iName === -1 || iPower === -1) continue;   // not a snapshot tab

    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var name = String(row[iName]).trim();
      if (!name) continue;

      var m = byName[name];
      if (!m) {
        m = byName[name] = { name: name, tier: '', power: nulls(dates.length), rank: nulls(dates.length) };
      }
      var power = Number(row[iPower]);
      if (!isNaN(power) && row[iPower] !== '') m.power[di] = power;
      if (iRank !== -1) {
        var rank = Number(row[iRank]);
        if (!isNaN(rank) && row[iRank] !== '') m.rank[di] = rank;
      }
      if (iTier !== -1) {
        var tier = String(row[iTier]).trim();
        if (tier) m.tier = tier;             // last seen wins: promotions show current rank
      }
    }
  }

  var members = [];
  for (var key in byName) members.push(byName[key]);
  return { count: dates.length, dates: dates, members: members };
}

/** Array of n nulls, without relying on Array.prototype.fill. */
function nulls(n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push(null);
  return a;
}

/** Editor sanity check: run this, then read the log. */
function testGetAll() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var res = getAll(ss, { limit: 3 });
  Logger.log('dates: ' + JSON.stringify(res.dates));
  Logger.log('members: ' + res.members.length);
  Logger.log('first: ' + JSON.stringify(res.members[0]));
}
