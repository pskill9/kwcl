/**
 * Web app that serves ranking sheet data as JSON.
 *
 * ENDPOINTS (via ?action=):
 *   ?action=sheets            -> list all sheet tabs + parsed date + row count
 *   ?action=data              -> return rows from a sheet (default action)
 *
 * DATA params (action=data):
 *   sheet=Sheet2      -> which sheet tab to read (default: first sheet)
 *   rank=5            -> return only the row with this Rank value
 *   tier=R4           -> return only rows matching this Tier
 *   limit=10          -> return only the first N rows (after other filters)
 *
 * Examples:
 *   <WEB_APP_URL>?action=sheets
 *   <WEB_APP_URL>?action=data&sheet=2026-07-23&tier=R4
 *   <WEB_APP_URL>?sheet=2026-07-23&rank=1
 *
 * NOTE on dates: Google does not expose a per-tab created date, so this API
 * derives the date from the sheet NAME. Name a tab so it contains a date like
 * 2026-07-23 (or 2026_07_23 / 2026.07.23) and it will be parsed automatically.
 */

var SPREADSHEET_ID = '1WaW5b7p4BkOslDMDzGeh3Slj3z-ILH4SSetqHZ7DsD4';

function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = (params.action || 'data').toLowerCase();

    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    if (action === 'sheets') {
      return jsonResponse(listSheets(ss));
    }
    if (action === 'insert') {
      return jsonResponse(insertRow(ss, params));
    }
    if (action === 'all') {
      return jsonResponse(getAll(ss, params));
    }
    return jsonResponse(getData(ss, params));
  } catch (err) {
    return jsonResponse({ error: String(err) });
  }
}

/** Parse a YYYY-MM-DD style date out of a sheet name. Returns ISO date or null. */
function parseDateFromName(name) {
  var m = String(name).match(/(\d{4})[-_.\/](\d{1,2})[-_.\/](\d{1,2})/);
  if (!m) return null;
  var y = m[1], mo = ('0' + m[2]).slice(-2), d = ('0' + m[3]).slice(-2);
  return y + '-' + mo + '-' + d;
}

/**
 * Tabs the public read endpoints refuse to serve.
 *
 * Reads are unauthenticated by design — the site is static and every visitor
 * needs the snapshots. But ?action=sheets enumerates tab NAMES and
 * ?action=data&sheet=<name> dumps any tab, so anything private stored in this
 * spreadsheet is one guessed name away from being public. Push Subs holds
 * every commander's endpoint and keys; Admin Log holds who logged in and when.
 *
 * Add a tab here BEFORE putting anything in it that shouldn't be world-readable.
 */
var PRIVATE_SHEETS = ['Push Subs', 'Admin Log'];

function isPrivateSheet(name) {
  var n = String(name || '').trim().toLowerCase();
  for (var i = 0; i < PRIVATE_SHEETS.length; i++) {
    if (PRIVATE_SHEETS[i].toLowerCase() === n) return true;
  }
  return false;
}

function listSheets(ss) {
  var sheets = ss.getSheets().filter(function (sh) {
    return !isPrivateSheet(sh.getName());
  }).map(function (sh) {
    var lastRow = sh.getLastRow();
    return {
      name: sh.getName(),
      date: parseDateFromName(sh.getName()),
      index: sh.getIndex(),
      rows: Math.max(0, lastRow - 1),   // minus header
      columns: sh.getLastColumn()
    };
  });
  return { count: sheets.length, sheets: sheets };
}

function getData(ss, params) {
  // Refuse before looking the tab up, so the reply cannot distinguish "private"
  // from "absent" and confirm what exists.
  if (params.sheet && isPrivateSheet(params.sheet)) {
    return { error: 'Sheet not found: ' + params.sheet };
  }
  var sheet = params.sheet ? ss.getSheetByName(params.sheet) : ss.getSheets()[0];
  if (!sheet) {
    return { error: 'Sheet not found: ' + params.sheet };
  }

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return { sheet: sheet.getName(), date: parseDateFromName(sheet.getName()), count: 0, data: [] };
  }

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = values.slice(1).map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });

  if (params.rank) {
    var r = Number(params.rank);
    rows = rows.filter(function (o) { return Number(o.Rank) === r; });
  }
  if (params.tier) {
    rows = rows.filter(function (o) {
      return String(o.Tier).toLowerCase() === String(params.tier).toLowerCase();
    });
  }
  if (params.limit) {
    rows = rows.slice(0, Number(params.limit));
  }

  return {
    sheet: sheet.getName(),
    date: parseDateFromName(sheet.getName()),
    count: rows.length,
    data: rows
  };
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

// Sanity checks you can run from the editor (select fn, press Run) before deploying.
function testListSheets() {
  Logger.log(doGet({ parameter: { action: 'sheets' } }).getContent());
}
function testReadData() {
  Logger.log(doGet({ parameter: {} }).getContent());
}

// ===== INSERT SUPPORT (added) =====
// Adds a row to a dated sheet tab. Columns written (created if missing):
//   Rank, Commander, Tier, Power, Donation, Kills
// The 'date' param (YYYY-MM-DD) selects/creates the tab; if omitted, uses today.
//
// Usage (POST, recommended):
//   POST <WEB_APP_URL>  body: {"date":"2026-07-25","rank":47,"commander":"Foo",
//                              "tier":"R4","power":50000000,"donation":1200,"kills":98765}
// Usage (GET, convenient for testing):
//   <WEB_APP_URL>?action=insert&date=2026-07-25&rank=47&commander=Foo&tier=R4&power=50000000&donation=1200&kills=98765

var INSERT_HEADERS = ['Rank', 'Commander', 'Tier', 'Power', 'Donation', 'Kills'];

function doPost(e) {
  try {
    var params = {};
    if (e && e.parameter) { for (var k in e.parameter) params[k] = e.parameter[k]; }
    if (e && e.postData && e.postData.contents) {
      try {
        var body = JSON.parse(e.postData.contents);
        for (var b in body) params[b] = body[b];
      } catch (ignore) {}
    }
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // Callout writes are the one path that needs a secret, so they route away
    // from insertRow before it runs. Everything else falls through unchanged —
    // push.py and the daily snapshot post no credentials and must keep working.
    var action = String(params.action || '').toLowerCase();
    if (action === 'callout') {
      return jsonResponse(postCallout(ss, params));
    }
    if (action === 'callout_expire') {
      return jsonResponse(expireCallout(ss, params));
    }
    if (action === 'callout_check') {
      return jsonResponse(checkCallout(ss, params));
    }
    if (action === 'push_key') {
      return jsonResponse(pushKey(ss, params));
    }
    if (action === 'push_relay') {
      return jsonResponse(pushRelay(ss, params));
    }
    // Subscribe and unsubscribe carry no secret on purpose: a commander cannot
    // be given the admin password. See the PUSH SUBSCRIPTIONS section for what
    // stands in for authentication.
    if (action === 'push_subscribe') {
      return jsonResponse(pushSubscribe(ss, params));
    }
    if (action === 'push_unsubscribe') {
      return jsonResponse(pushUnsubscribe(ss, params));
    }
    if (action === 'push_list') {
      return jsonResponse(pushList(ss, params));
    }
    if (action === 'push_claim') {
      return jsonResponse(pushClaim(ss, params));
    }
    if (action === 'push_apply') {
      return jsonResponse(pushApplyResults(ss, params));
    }

    return jsonResponse(insertRow(ss, params));
  } catch (err) {
    return jsonResponse({ error: String(err) });
  }
}

/** Return YYYY-MM-DD for today in the spreadsheet's timezone. */
function todayIso(ss) {
  var tz = ss.getSpreadsheetTimeZone() || 'Etc/UTC';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

/** Find a sheet tab whose parsed date matches, or whose name equals, the given date. */
function findSheetForDate(ss, dateStr) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (sh.getName() === dateStr) return sh;
    if (parseDateFromName(sh.getName()) === dateStr) return sh;
  }
  return null;
}

/**
 * Ensure the header row exists and contains every header in `wanted`.
 * Returns a map header -> column index (0-based).
 *
 * `wanted` is passed in rather than always being INSERT_HEADERS so that
 * optional columns (isActive) appear only on the tabs that actually use them,
 * instead of being added as empty columns to every daily snapshot tab.
 */
function ensureHeaders(sheet, wanted) {
  wanted = wanted || INSERT_HEADERS;
  var lastCol = sheet.getLastColumn();
  var headers = [];
  if (sheet.getLastRow() >= 1 && lastCol >= 1) {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  }
  var changed = false;
  for (var i = 0; i < wanted.length; i++) {
    if (headers.indexOf(wanted[i]) === -1) {
      headers.push(wanted[i]);
      changed = true;
    }
  }
  if (changed || sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  var map = {};
  for (var j = 0; j < headers.length; j++) map[headers[j]] = j;
  return map;
}

/** Insert a data row. Returns a status object (also used by doGet ?action=insert and doPost). */
function insertRow(ss, params) {
  var dateStr = params.date ? String(params.date).trim() : todayIso(ss);
  var mDate = dateStr.match(/(\d{4})[-_.\/](\d{1,2})[-_.\/](\d{1,2})/);
  if (mDate) {
    dateStr = mDate[1] + '-' + ('0' + mDate[2]).slice(-2) + '-' + ('0' + mDate[3]).slice(-2);
  }

  var sheet = findSheetForDate(ss, dateStr);
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(dateStr);
    created = true;
  }

  // isActive is only ensured (and only written) when the caller sends it, so
  // daily snapshot tabs don't sprout an empty column they never use.
  var wanted = INSERT_HEADERS;
  if (params.isActive !== undefined && params.isActive !== null && params.isActive !== '') {
    wanted = INSERT_HEADERS.concat(['isActive']);
  }
  var colMap = ensureHeaders(sheet, wanted);

  // Build a value map keyed by header name.
  var valueFor = {
    'Rank': params.rank,
    'Commander': params.commander,
    'Tier': params.tier,
    'Power': params.power,
    'Donation': params.donation,
    'Kills': params.kills,
    'isActive': params.isActive
  };

  function coerce(key, val) {
    if (val === undefined || val === null || val === '') return null;
    if (key === 'Rank' || key === 'Power' || key === 'Donation' || key === 'Kills') {
      var n = Number(val);
      return isNaN(n) ? val : n;
    }
    if (key === 'isActive') {
      // arrives as a real boolean over POST and as the string "true"/"false"
      // over GET; store a checkbox-friendly boolean either way
      if (typeof val === 'boolean') return val;
      var s = String(val).trim().toLowerCase();
      if (s === 'true' || s === 'yes' || s === '1') return true;
      if (s === 'false' || s === 'no' || s === '0') return false;
      return val;
    }
    return val;
  }

  var width = Math.max(sheet.getLastColumn(), INSERT_HEADERS.length);
  var commanderCol = colMap['Commander'];
  var commanderVal = params.commander !== undefined && params.commander !== null
    ? String(params.commander).trim()
    : '';

  // Look for an existing row with the same Commander in this (dated) tab.
  var existingRowNumber = 0;
  if (commanderVal !== '' && commanderCol !== undefined && sheet.getLastRow() >= 2) {
    var colVals = sheet.getRange(2, commanderCol + 1, sheet.getLastRow() - 1, 1).getValues();
    for (var r = 0; r < colVals.length; r++) {
      if (String(colVals[r][0]).trim() === commanderVal) {
        existingRowNumber = r + 2; // +2: skip header, 1-based
        break;
      }
    }
  }

  var updated = false;
  var rowNumber;
  var row;

  if (existingRowNumber) {
    // UPDATE existing row: read it, overwrite only the fields provided.
    updated = true;
    rowNumber = existingRowNumber;
    row = sheet.getRange(rowNumber, 1, 1, width).getValues()[0];
    while (row.length < width) row.push('');
    for (var key in valueFor) {
      var idx = colMap[key];
      var cv = coerce(key, valueFor[key]);
      if (idx === undefined || cv === null) continue;
      row[idx] = cv;
    }
    sheet.getRange(rowNumber, 1, 1, width).setValues([row]);
  } else {
    // INSERT new row.
    row = [];
    for (var c = 0; c < width; c++) row.push('');
    for (var key2 in valueFor) {
      var idx2 = colMap[key2];
      var cv2 = coerce(key2, valueFor[key2]);
      if (idx2 === undefined || cv2 === null) continue;
      row[idx2] = cv2;
    }
    sheet.appendRow(row);
    rowNumber = sheet.getLastRow();
  }

  return {
    ok: true,
    action: updated ? 'updated' : 'inserted',
    sheet: sheet.getName(),
    date: parseDateFromName(sheet.getName()) || dateStr,
    createdSheet: created,
    rowNumber: rowNumber,
    written: row
  };
}

/** Editor sanity check: inserts a sample row into today's tab. Run this, then check the sheet. */
function testInsertRow() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var res = insertRow(ss, {
    date: '2026-07-25',
    rank: 999,
    commander: 'TEST Commander',
    tier: 'R4',
    power: 12345678,
    donation: 1000,
    kills: 55555
  });
  Logger.log(JSON.stringify(res, null, 2));
}

// ===== BULK READ (added) =====
// ?action=all — one request for every dated tab.
//
// The site used to make one request per day plus one to list the tabs. Apps
// Script answers in 1.5-15s per call regardless of payload size, and the tab
// list had to return before any day could be fetched, so a cold load spent
// ~6.7s in two serial waves. This collapses that to a single call.
//
// The response is columnar — each commander appears once with an array of
// values per date — because a per-day response repeats all ~100 names on every
// single day. Over 120 days that is ~1.7MB of mostly duplicated names; this
// shape is roughly a tenth of it.
//
// PARAMS
//   since=YYYY-MM-DD  only tabs on or after this date (INCLUSIVE, so the
//                     caller's newest cached day comes back refreshed)
//   limit=120         keep only the most recent N tabs after filtering
//
// SHAPE
//   { count, dates: ["2026-07-23", ...],                        // ascending
//     members: [ { name, tier, power: [...], rank: [...] } ] }  // null per absent day
//
// Undated tabs (Roster, Hall of Fame) are skipped: parseDateFromName returns
// null for them, the same rule the daily snapshot loader already uses.
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

// ===== CALLOUTS / SHOUTOUTS (added) =====
// Short, time-limited messages shown in the site's Shoutouts section.
//
// READING needs nothing new: the site fetches
//   ?action=data&sheet=Shoutouts
// through getData, exactly the way the Hall of Fame tab is read.
//
// WRITING is guarded by a shared secret, because the site is static and served
// from GitHub Pages — anything in app.js is readable by every visitor, so a
// password checked in the browser protects nothing. The secret lives in Script
// Properties where the browser never sees it.
//
// SETUP (once, in the Apps Script UI):
//   Project Settings -> Script Properties -> Add
//   name: CALLOUT_SECRET     value: <the password admins will type>
// Until that property is set, every callout write is refused (fail closed), so
// a fresh deployment is never briefly open to anyone.
//
// POST <WEB_APP_URL>
//   {"action":"callout","secret":"…","type":"shoutout",
//    "commander":"피자감자","message":"Carried the whole VS","hours":72,
//    "author":"Makpy"}
//   -> {ok:true, id:"s_1754…", expires:"2026-08-05T09:00:00.000Z"}
//
//   {"action":"callout_expire","secret":"…","id":"s_1754…"}
//   -> {ok:true, id:"s_1754…", expires:"<now>"}
//
// `hours` omitted (or 0) means "until removed" — Expires is left blank.

var CALLOUT_SHEET = 'Shoutouts';
// Login attempts go here, NOT into Shoutouts. Verifying a password used to
// mean posting a real callout and expiring it, which littered the callout tab
// with "(admin unlock check)" rows on every single login.
var ADMIN_LOG_SHEET = 'Admin Log';
var ADMIN_LOG_HEADERS = ['Time', 'Event', 'Result', 'Detail'];
// Commander holds one name, or several joined by ', ' when a shoutout covers a
// group. No commander name on record contains a comma, and the joined form
// stays readable to anyone opening the sheet.
// Badge is an optional key from config.callouts.badges (e.g. 'healer').
var CALLOUT_HEADERS = ['Id', 'Type', 'Commander', 'Badge', 'Message', 'Created', 'Expires',
                       'Author', 'Pushed', 'PushToken'];

/**
 * True only when a non-empty CALLOUT_SECRET is configured AND matches.
 *
 * Fails closed on purpose: an unset property means refuse, never allow. The
 * reply never echoes the configured value.
 */
function calloutSecretOk(provided) {
  var want = '';
  try {
    want = PropertiesService.getScriptProperties().getProperty('CALLOUT_SECRET') || '';
  } catch (e) {
    return false;
  }
  want = String(want).trim();
  if (!want) return false;                     // not configured -> nobody gets in
  return String(provided == null ? '' : provided).trim() === want;
}

/** Get the Shoutouts tab, creating it (with headers) the first time. */
function calloutSheet(ss) {
  var sh = ss.getSheetByName(CALLOUT_SHEET);
  if (!sh) sh = ss.insertSheet(CALLOUT_SHEET);
  ensureHeaders(sh, CALLOUT_HEADERS);
  return sh;
}

/** header name -> 0-based column index, for the Shoutouts tab as it stands. */
function calloutColMap(sh) {
  var lastCol = Math.max(sh.getLastColumn(), CALLOUT_HEADERS.length);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var map = {};
  for (var i = 0; i < headers.length; i++) map[headers[i]] = i;
  return { map: map, width: headers.length };
}

/** Append one callout. Returns a status object. */
function postCallout(ss, params) {
  if (!calloutSecretOk(params.secret)) {
    return { ok: false, error: 'unauthorized' };
  }

  // Beyond the two built-in kinds, any safe slug is accepted and stored as-is:
  // one-tap alert types live in config.js, which this script never sees, so
  // validating against a fixed list here would mean editing the backend every
  // time the alliance adds a button. The slug rule is the whole guard — it
  // keeps the Type column readable and rules out anything injected.
  var type = String(params.type || 'announcement').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,19}$/.test(type)) type = 'announcement';

  var message = String(params.message == null ? '' : params.message).trim();
  // A one-tap alert has nothing composed, so it carries its own wording rather
  // than forcing the admin to retype the same line under time pressure.
  if (!message && type !== 'shoutout' && type !== 'announcement') {
    message = 'Alert.';
  }
  if (!message) return { ok: false, error: 'message is required' };

  // A shoutout with no name is just an announcement wearing the wrong hat.
  var commander = String(params.commander == null ? '' : params.commander).trim();
  if (type === 'shoutout' && !commander) {
    return { ok: false, error: 'a shoutout needs a commander' };
  }

  var now = new Date();
  // `minutes` wins when given. Treasure runs for ten minutes, and `hours`
  // cannot express that without a fraction that reads like a typo to anyone
  // opening the sheet.
  var mins = Number(params.minutes);
  var hours = Number(params.hours);
  var ms = 0;
  if (!isNaN(mins) && mins > 0) ms = mins * 60 * 1000;
  else if (!isNaN(hours) && hours > 0) ms = hours * 3600 * 1000;   // 0 => until removed
  var expires = ms > 0 ? new Date(now.getTime() + ms) : null;

  // Timestamp alone collides when two callouts land in the same millisecond,
  // and a duplicate id makes "remove now" expire whichever row matched first —
  // i.e. potentially the wrong callout. The random suffix makes that unlikely
  // enough to ignore while keeping ids sortable by creation time.
  var id = 's_' + now.getTime() + '_' + Math.floor(Math.random() * 1679616).toString(36);

  var sh = calloutSheet(ss);
  var cm = calloutColMap(sh);
  var row = [];
  for (var i = 0; i < cm.width; i++) row.push('');

  var valueFor = {
    'Id': id,
    'Type': type,
    'Commander': commander,
    'Badge': String(params.badge == null ? '' : params.badge).trim(),
    'Message': message,
    'Created': now.toISOString(),
    'Expires': expires ? expires.toISOString() : '',
    'Author': String(params.author == null ? '' : params.author).trim()
  };
  for (var key in valueFor) {
    var idx = cm.map[key];
    if (idx !== undefined) row[idx] = valueFor[key];
  }

  sh.appendRow(row);

  return {
    ok: true,
    id: id,
    type: type,
    commander: commander,
    badge: valueFor['Badge'],
    expires: expires ? expires.toISOString() : null,
    rowNumber: sh.getLastRow()
  };
}

/** Expire one callout immediately by stamping Expires = now. */
function expireCallout(ss, params) {
  if (!calloutSecretOk(params.secret)) {
    return { ok: false, error: 'unauthorized' };
  }

  var id = String(params.id == null ? '' : params.id).trim();
  if (!id) return { ok: false, error: 'id is required' };

  var sh = ss.getSheetByName(CALLOUT_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'no callouts' };

  var cm = calloutColMap(sh);
  var idCol = cm.map['Id'];
  var expCol = cm.map['Expires'];
  if (idCol === undefined || expCol === undefined) {
    return { ok: false, error: 'Shoutouts tab is missing Id/Expires columns' };
  }

  var ids = sh.getRange(2, idCol + 1, sh.getLastRow() - 1, 1).getValues();
  for (var r = 0; r < ids.length; r++) {
    if (String(ids[r][0]).trim() === id) {
      var stamp = new Date().toISOString();
      sh.getRange(r + 2, expCol + 1).setValue(stamp);
      return { ok: true, id: id, expires: stamp, rowNumber: r + 2 };
    }
  }
  return { ok: false, error: 'id not found: ' + id };
}

/**
 * Claim a callout for notification, exactly once.
 *
 * This exists because of a failure mode already documented in admin.js: Apps
 * Script answers a perfectly good POST with a lost response, so the client
 * retries. For a sheet write that is harmless — postThenVerify reads the row
 * back. For a notification it is not: the push already went to a hundred
 * phones and the retry sends it again.
 *
 * So the send is gated on a claim. The first caller to claim a callout id gets
 * claimed:true and may send; every later caller gets claimed:false. Stamping
 * and checking happen under a script lock, because two admins posting in the
 * same second would otherwise both read "not yet pushed" and both send.
 *
 * `force` is for the human-operated Retry button, where a repeat is the point.
 */
function pushClaim(ss, params) {
  if (!calloutSecretOk(params.secret)) return { ok: false, error: 'unauthorized' };

  var id = String(params.calloutId == null ? '' : params.calloutId).trim();
  if (!id) return { ok: false, error: 'calloutId is required' };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    // Refuse rather than guess. A caller that cannot get the lock must not
    // assume it is safe to send.
    return { ok: false, error: 'busy, try again' };
  }

  try {
    // calloutSheet, not getSheetByName: it runs ensureHeaders, which adds the
    // Pushed column to a tab that predates it. Reading the sheet directly
    // meant every claim on an existing Shoutouts tab failed with "missing
    // Id/Pushed columns", so no notification could ever be sent.
    var sh = calloutSheet(ss);
    if (sh.getLastRow() < 2) return { ok: false, error: 'no callouts' };

    var cm = calloutColMap(sh);
    var idCol = cm.map['Id'], pushCol = cm.map['Pushed'];
    if (idCol === undefined || pushCol === undefined) {
      return { ok: false, error: 'Shoutouts tab is missing Id/Pushed columns' };
    }

    var tokenCol = cm.map['PushToken'];
    var token = String(params.token == null ? '' : params.token).trim();

    var ids = sh.getRange(2, idCol + 1, sh.getLastRow() - 1, 1).getValues();
    for (var r = 0; r < ids.length; r++) {
      if (String(ids[r][0]).trim() !== id) continue;

      var row = r + 2;
      var already = String(sh.getRange(row, pushCol + 1).getValue() || '').trim();
      var by = tokenCol === undefined ? '' : String(sh.getRange(row, tokenCol + 1).getValue() || '').trim();

      if (already) {
        // The caller's OWN earlier attempt. This matters more than it looks:
        // the client retries a lost POST, so attempt 1 can stamp the row and
        // lose its response, and attempt 2 would then be told "already sent"
        // — blocking the very notification the claim exists to protect. A
        // claim must be idempotent for the caller that made it.
        if (token && by && by === token) {
          logAdmin(ss, 'push_claim', 'retry', id);
          return { ok: true, claimed: true, pushedAt: already, repeat: true };
        }
        if (!params.force) {
          logAdmin(ss, 'push_claim', 'duplicate', id);
          return { ok: true, claimed: false, pushedAt: already };
        }
      }

      var stamp = new Date().toISOString();
      sh.getRange(row, pushCol + 1).setValue(stamp);
      if (tokenCol !== undefined) sh.getRange(row, tokenCol + 1).setValue(token);
      logAdmin(ss, 'push_claim', params.force ? 'forced' : 'ok', id);
      return { ok: true, claimed: true, pushedAt: stamp };
    }
    return { ok: false, error: 'id not found: ' + id };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Append one line to the Admin Log tab, creating it on first use.
 * Never throws: an audit line failing must not break the action being audited.
 */
function logAdmin(ss, event, result, detail) {
  try {
    var sh = ss.getSheetByName(ADMIN_LOG_SHEET);
    if (!sh) sh = ss.insertSheet(ADMIN_LOG_SHEET);
    ensureHeaders(sh, ADMIN_LOG_HEADERS);
    sh.appendRow([new Date().toISOString(), event, result,
                  String(detail == null ? '' : detail).slice(0, 200)]);
  } catch (e) { /* logging is best-effort */ }
}

/**
 * Verify the password WITHOUT writing anything to the callout tab.
 *
 * Denied attempts are logged too — with no rate limiting in front of this
 * endpoint, a run of failures in the log is the only visible sign of someone
 * guessing at the password.
 */
function checkCallout(ss, params) {
  var ok = calloutSecretOk(params.secret);
  logAdmin(ss, 'login', ok ? 'ok' : 'denied',
           String(params.who == null ? '' : params.who).trim());
  return ok ? { ok: true } : { ok: false, error: 'unauthorized' };
}

/** Editor sanity check. Set CALLOUT_SECRET first, then edit the secret below. */
function testPostCallout() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Logger.log(JSON.stringify(postCallout(ss, {
    secret: 'REPLACE_ME',
    type: 'announcement',
    message: 'TEST — ignore',
    hours: 1
  }), null, 2));
}

// ===== PUSH RELAY (added) =====
//
// The site is static and Apps Script has no ECDSA and no AES-GCM, so it cannot
// build a Web Push message itself. The admin browser can — it has WebCrypto —
// but it cannot DELIVER one: FCM and Apple answer a CORS preflight with no
// Access-Control-Allow-Origin, so the browser blocks the final POST before it
// is sent. (Mozilla does allow it. Chrome, Edge and Safari do not.)
//
// So the work is split. The browser signs and encrypts; this relays the bytes.
// Server-to-server has no preflight, so the POST simply goes.
//
//   browser:  encrypt + sign  ->  push_relay  ->  push service  ->  phone
//
// This code does NO crypto and never sees a key. It receives finished bytes
// and posts them to an allowlisted host.
//
// POST <WEB_APP_URL>
//   {"action":"push_relay","secret":"…","items":[
//      {"endpoint":"https://fcm.googleapis.com/fcm/send/…",
//       "headers":{"Authorization":"vapid t=…, k=…","TTL":"86400", …},
//       "bodyB64":"<base64url of the aes128gcm record>"}]}
//   -> {ok:true, sent:1, results:[{endpoint:"…", status:201}]}

// Only these hosts may be posted to. Without this the endpoint is an open
// relay for anyone holding the admin password — bounded is not the same as
// safe, but an unbounded one is indefensible.
var PUSH_HOSTS = [
  'fcm.googleapis.com',                 // Chrome, Edge
  'web.push.apple.com',                 // Safari
  '.push.services.mozilla.com',         // Firefox  (suffix match)
  '.notify.windows.com'                 // legacy Edge / Windows  (suffix match)
];

// Headers the push protocol needs. Anything else the caller sends is dropped:
// this relay forwards a Web Push request, not an arbitrary one.
var PUSH_HEADER_ALLOW = ['Authorization', 'TTL', 'Urgency', 'Topic', 'Content-Encoding'];

var PUSH_MAX_ITEMS = 25;      // one batch; the browser chunks a bigger roster
var PUSH_MAX_BODY = 4300;     // a 4096-byte record, base64url-inflated, plus slack

/** True if the endpoint is https and its host is one we relay to. */
function pushHostAllowed(endpoint) {
  var m = String(endpoint || '').match(/^https:\/\/([^\/\?#]+)/i);
  if (!m) return false;
  var host = m[1].toLowerCase();
  for (var i = 0; i < PUSH_HOSTS.length; i++) {
    var want = PUSH_HOSTS[i];
    if (want.charAt(0) === '.') {
      if (host.length > want.length && host.slice(-want.length) === want) return true;
    } else if (host === want) {
      return true;
    }
  }
  return false;
}

/**
 * Hand the VAPID private key to an authenticated admin.
 *
 * READ THIS BEFORE CHANGING IT. Unlike CALLOUT_SECRET — which is only ever
 * compared here and never sent anywhere — this endpoint DISCLOSES a secret to
 * the browser. Two consequences that are easy to miss:
 *
 *   1. Anyone who learns the admin password can keep a permanent ability to
 *      push notifications to every subscribed commander. Changing the password
 *      afterwards does not revoke it.
 *   2. The only revocation is rotating the VAPID pair, which invalidates every
 *      subscription in existence — everyone has to subscribe again.
 *
 * That trade was made deliberately to avoid running a separate send service.
 * If it ever stops looking worth it, push/worker.js is the alternative and the
 * crypto module moves across unchanged.
 */
function pushKey(ss, params) {
  if (!calloutSecretOk(params.secret)) {
    logAdmin(ss, 'push_key', 'denied', String(params.who || ''));
    return { ok: false, error: 'unauthorized' };
  }
  var props = PropertiesService.getScriptProperties();
  var priv = String(props.getProperty('VAPID_PRIVATE') || '').trim();
  var pub = String(props.getProperty('VAPID_PUBLIC') || '').trim();
  var subject = String(props.getProperty('VAPID_SUBJECT') || '').trim();

  if (!priv || !pub) {
    return { ok: false, error: 'VAPID_PRIVATE / VAPID_PUBLIC are not set in Script Properties' };
  }
  logAdmin(ss, 'push_key', 'ok', String(params.who || ''));
  return { ok: true, publicKey: pub, privateKey: priv, subject: subject || 'mailto:admin@example.com' };
}

/**
 * Relay pre-encrypted push messages. Returns one status per item, in order.
 *
 * Statuses are passed through verbatim rather than collapsed into ok/fail,
 * because the caller has to tell them apart: 201 is delivered, 410 means the
 * subscription is dead and should be pruned, 429 means slow down.
 */
function pushRelay(ss, params) {
  if (!calloutSecretOk(params.secret)) {
    logAdmin(ss, 'push_relay', 'denied', '');
    return { ok: false, error: 'unauthorized' };
  }

  var items = params.items;
  if (!items || !items.length) return { ok: false, error: 'items is required' };
  if (items.length > PUSH_MAX_ITEMS) {
    return { ok: false, error: 'too many items: ' + items.length + ' > ' + PUSH_MAX_ITEMS };
  }

  var requests = [];
  var rejected = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    if (!pushHostAllowed(it.endpoint)) {
      rejected.push({ index: i, endpoint: String(it.endpoint || ''), status: 0, error: 'host not allowed' });
      continue;
    }
    if (!it.bodyB64 || String(it.bodyB64).length > PUSH_MAX_BODY) {
      rejected.push({ index: i, endpoint: it.endpoint, status: 0, error: 'body missing or too large' });
      continue;
    }

    var headers = {};
    var given = it.headers || {};
    for (var h = 0; h < PUSH_HEADER_ALLOW.length; h++) {
      var name = PUSH_HEADER_ALLOW[h];
      if (given[name] !== undefined && given[name] !== null && given[name] !== '') {
        headers[name] = String(given[name]);
      }
    }
    if (!headers['Authorization']) {
      rejected.push({ index: i, endpoint: it.endpoint, status: 0, error: 'missing Authorization' });
      continue;
    }
    // FCM refuses a push with no TTL, so default it rather than fail the send.
    if (!headers['TTL']) headers['TTL'] = '86400';

    requests.push({
      index: i,
      endpoint: it.endpoint,
      request: {
        url: it.endpoint,
        method: 'post',
        contentType: 'application/octet-stream',
        headers: headers,
        // base64DecodeWebSafe, not base64Decode: the body arrives base64url.
        payload: Utilities.base64DecodeWebSafe(String(it.bodyB64)),
        muteHttpExceptions: true,
        followRedirects: false,
        validateHttpsCertificates: true
      }
    });
  }

  var results = [];
  if (requests.length) {
    var raw = [];
    for (var r = 0; r < requests.length; r++) raw.push(requests[r].request);

    var responses;
    try {
      responses = UrlFetchApp.fetchAll(raw);
    } catch (err) {
      // Catching here is deliberate: a push that fails must never take the
      // shoutout down with it. But it has one surprising side effect — an
      // unauthorized-scope error caught here does NOT raise the authorization
      // dialog, because Apps Script only prompts when that error propagates
      // uncaught. The execution just "completes" with this message instead.
      // Run authorizePush() once to grant the scope; see its comment below.
      var msg = String(err);
      if (msg.indexOf('permission') !== -1 || msg.indexOf('external_request') !== -1) {
        logAdmin(ss, 'push_relay', 'error', 'not authorized for external requests');
        return {
          ok: false,
          error: 'not authorized: run authorizePush() once in the Apps Script editor ' +
                 'and approve the prompt, then retry. (' + msg.slice(0, 120) + ')'
        };
      }
      logAdmin(ss, 'push_relay', 'error', msg.slice(0, 180));
      return { ok: false, error: 'fetchAll failed: ' + msg };
    }

    for (var k = 0; k < responses.length; k++) {
      var code = responses[k].getResponseCode();
      var entry = {
        index: requests[k].index,
        endpoint: requests[k].endpoint,
        status: code
      };
      // A push service says nothing useful on success; on refusal it explains.
      if (code < 200 || code > 299) {
        entry.body = String(responses[k].getContentText() || '').slice(0, 300);
      }
      results.push(entry);
    }
  }

  for (var j = 0; j < rejected.length; j++) results.push(rejected[j]);
  results.sort(function (a, b) { return a.index - b.index; });

  var sent = 0, gone = 0;
  for (var n = 0; n < results.length; n++) {
    if (results[n].status >= 200 && results[n].status <= 299) sent++;
    if (results[n].status === 404 || results[n].status === 410) gone++;
  }

  logAdmin(ss, 'push_relay', 'ok', sent + '/' + results.length + ' sent, ' + gone + ' gone');
  return { ok: true, sent: sent, gone: gone, count: results.length, results: results };
}

/**
 * Grant the external-request scope. Run this ONCE, from the editor, before
 * the first relay send. Select it, press Run, approve the prompt.
 *
 * It exists because pushRelay wraps fetchAll in try/catch — the right call in
 * production, since a failed push must not break a shoutout — but a caught
 * scope error never reaches Apps Script's authorization machinery, so no
 * consent dialog appears and the run reports success. This function makes the
 * same kind of call with NO error handling, so the error propagates and the
 * dialog opens.
 *
 * Do not add a try/catch here. That is the entire point of the function.
 *
 * FCM will answer the probe with 400 (the body is nonsense). That is success:
 * a status code coming back at all means the scope was granted and the request
 * left the building.
 */
function authorizePush() {
  var res = UrlFetchApp.fetch('https://fcm.googleapis.com/fcm/send/authorize-probe', {
    method: 'post',
    contentType: 'application/octet-stream',
    payload: 'probe',
    muteHttpExceptions: true
  });
  Logger.log('Authorized. FCM answered ' + res.getResponseCode() +
             ' — any status here means the scope is granted.');
}

/**
 * Editor sanity check for the relay path, with no browser and no subscription.
 *
 * It posts a deliberately malformed body to a real FCM endpoint shape. The
 * push service will refuse it — that is fine and expected. What this proves is
 * the thing that actually needed proving: that UrlFetchApp passes
 * Content-Encoding and Authorization through to the push service unmodified,
 * and hands the status code back rather than throwing.
 *
 * A 400 or 401 here means the relay works. A 403 about the VAPID key means the
 * relay works too. Only a thrown exception, or a stripped-header complaint,
 * means it does not.
 */
function testPushRelay() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var out = pushRelay(ss, {
    secret: PropertiesService.getScriptProperties().getProperty('CALLOUT_SECRET'),
    items: [{
      endpoint: 'https://fcm.googleapis.com/fcm/send/relay-smoke-test',
      headers: {
        Authorization: 'vapid t=not.a.real.jwt, k=notarealkey',
        'Content-Encoding': 'aes128gcm',
        TTL: '60'
      },
      bodyB64: 'AAAAAAAAAAAAAAAAAAAAAA'
    }]
  });
  Logger.log(JSON.stringify(out, null, 2));
}

// ===== PUSH SUBSCRIPTIONS (added) =====
//
// One row per subscribed device. There is deliberately NO commander name:
// subscribing is one tap, and every subscriber gets the same message. Adding
// identity later means adding a column and a picker — nothing here has to
// change shape for that.
//
// Reads and writes here are UNAUTHENTICATED, because a commander cannot be
// given the admin password. What stands in for auth:
//   - the endpoint host must be a real push service (pushHostAllowed)
//   - values are length-capped and the table has a row ceiling
//   - subscribe upserts by endpoint, so re-tapping never duplicates
//   - unsubscribe is keyed by ENDPOINT, never by anything guessable, so
//     knowing the endpoint is itself the proof of ownership
//
// The tab is in PRIVATE_SHEETS, so ?action=data cannot read it back out.
//
// POST {"action":"push_subscribe","subscription":{"endpoint":"…","keys":{"p256dh":"…","auth":"…"}}}
// POST {"action":"push_unsubscribe","endpoint":"…"}
// POST {"action":"push_list","secret":"…"}          <- admin only

var PUSH_SHEET = 'Push Subs';
var PUSH_HEADERS = ['Id', 'Endpoint', 'P256dh', 'Auth', 'Created', 'LastSeen',
                    'LastResult', 'Fails', 'Disabled', 'UA'];

var PUSH_SUBS_MAX = 500;      // ~100 commanders, several devices each, headroom
var PUSH_ENDPOINT_MAX = 500;  // real endpoints run ~200 chars
var PUSH_KEY_MAX = 200;

function pushSheet(ss) {
  var sh = ss.getSheetByName(PUSH_SHEET);
  if (!sh) sh = ss.insertSheet(PUSH_SHEET);
  ensureHeaders(sh, PUSH_HEADERS);
  return sh;
}

/** header name -> 0-based column index for the Push Subs tab as it stands. */
function pushColMap(sh) {
  var lastCol = Math.max(sh.getLastColumn(), PUSH_HEADERS.length);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var map = {};
  for (var i = 0; i < headers.length; i++) map[headers[i]] = i;
  return { map: map, width: headers.length };
}

/** Row number (1-based, as the sheet counts) for an endpoint, or 0. */
function pushFindRow(sh, cm, endpoint) {
  if (sh.getLastRow() < 2) return 0;
  var col = cm.map['Endpoint'];
  if (col === undefined) return 0;
  var values = sh.getRange(2, col + 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === endpoint) return i + 2;
  }
  return 0;
}

/** Store or refresh one subscription. Returns a status object. */
function pushSubscribe(ss, params) {
  var sub = params.subscription || {};
  var keys = sub.keys || {};
  var endpoint = String(sub.endpoint == null ? '' : sub.endpoint).trim();
  var p256dh = String(keys.p256dh == null ? '' : keys.p256dh).trim();
  var auth = String(keys.auth == null ? '' : keys.auth).trim();

  if (!endpoint || !p256dh || !auth) {
    return { ok: false, error: 'subscription must have endpoint and keys.p256dh and keys.auth' };
  }
  if (!pushHostAllowed(endpoint)) {
    return { ok: false, error: 'endpoint is not a recognised push service' };
  }
  if (endpoint.length > PUSH_ENDPOINT_MAX ||
      p256dh.length > PUSH_KEY_MAX || auth.length > PUSH_KEY_MAX) {
    return { ok: false, error: 'subscription fields are too long' };
  }

  var sh = pushSheet(ss);
  var cm = pushColMap(sh);

  // A rotated subscription supersedes the old row rather than leaving a dead
  // one behind for the pruner to find later.
  var replaces = String(params.replaces == null ? '' : params.replaces).trim();
  if (replaces && replaces !== endpoint) {
    var oldRow = pushFindRow(sh, cm, replaces);
    if (oldRow) sh.deleteRow(oldRow);
    cm = pushColMap(sh);
  }

  var now = new Date().toISOString();
  var row = pushFindRow(sh, cm, endpoint);

  if (row) {
    // Re-tapping the bell refreshes the keys and clears any strikes, so a
    // subscription disabled by an outage comes back on its own.
    setIfPresent(sh, cm, row, 'P256dh', p256dh);
    setIfPresent(sh, cm, row, 'Auth', auth);
    setIfPresent(sh, cm, row, 'LastSeen', now);
    setIfPresent(sh, cm, row, 'Fails', 0);
    setIfPresent(sh, cm, row, 'Disabled', '');
    logAdmin(ss, 'push_subscribe', 'ok', 'refreshed row ' + row);
    return { ok: true, created: false, rowNumber: row };
  }

  if (sh.getLastRow() - 1 >= PUSH_SUBS_MAX) {
    logAdmin(ss, 'push_subscribe', 'denied', 'table full');
    return { ok: false, error: 'subscription list is full' };
  }

  var id = 'p_' + new Date().getTime() + '_' + Math.floor(Math.random() * 1679616).toString(36);
  var values = {
    'Id': id, 'Endpoint': endpoint, 'P256dh': p256dh, 'Auth': auth,
    'Created': now, 'LastSeen': now, 'LastResult': '', 'Fails': 0, 'Disabled': '',
    'UA': String(params.ua == null ? '' : params.ua).slice(0, 180)
  };
  var line = [];
  for (var i = 0; i < cm.width; i++) line.push('');
  for (var key in values) {
    var idx = cm.map[key];
    if (idx !== undefined) line[idx] = values[key];
  }
  sh.appendRow(line);

  logAdmin(ss, 'push_subscribe', 'ok', 'new row ' + sh.getLastRow());
  return { ok: true, created: true, id: id, rowNumber: sh.getLastRow() };
}

function setIfPresent(sh, cm, row, header, value) {
  var idx = cm.map[header];
  if (idx !== undefined) sh.getRange(row, idx + 1).setValue(value);
}

/** Remove one subscription. Keyed by endpoint: knowing it is the proof. */
function pushUnsubscribe(ss, params) {
  var endpoint = String(params.endpoint == null ? '' : params.endpoint).trim();
  if (!endpoint) return { ok: false, error: 'endpoint is required' };

  var sh = ss.getSheetByName(PUSH_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: true, removed: false };

  var cm = pushColMap(sh);
  var row = pushFindRow(sh, cm, endpoint);
  if (!row) return { ok: true, removed: false };

  sh.deleteRow(row);
  logAdmin(ss, 'push_unsubscribe', 'ok', 'row ' + row);
  return { ok: true, removed: true };
}

/**
 * Every live subscription. Admin only — these are the credentials needed to
 * push to somebody's device, and the tab is private for the same reason.
 */
function pushList(ss, params) {
  if (!calloutSecretOk(params.secret)) {
    logAdmin(ss, 'push_list', 'denied', '');
    return { ok: false, error: 'unauthorized' };
  }

  var sh = ss.getSheetByName(PUSH_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: true, count: 0, subs: [] };

  var cm = pushColMap(sh);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, cm.width).getValues();
  var subs = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (String(r[cm.map['Disabled']] || '').trim()) continue;   // skip pruned
    var endpoint = String(r[cm.map['Endpoint']] || '').trim();
    if (!endpoint) continue;
    subs.push({
      id: String(r[cm.map['Id']] || ''),
      endpoint: endpoint,
      keys: {
        p256dh: String(r[cm.map['P256dh']] || ''),
        auth: String(r[cm.map['Auth']] || '')
      }
    });
  }
  return { ok: true, count: subs.length, subs: subs };
}

/**
 * Apply the statuses a send produced: stamp the live ones, retire the dead.
 *
 * Called with whatever pushRelay returned. Kept separate from pushRelay so the
 * relay stays a dumb transport that knows nothing about the subscription
 * table — which is what lets a Cloudflare Worker replace it later without
 * touching any of this.
 */
function pushApplyResults(ss, params) {
  if (!calloutSecretOk(params.secret)) return { ok: false, error: 'unauthorized' };

  var results = params.results || [];
  var sh = ss.getSheetByName(PUSH_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: true, updated: 0, disabled: 0 };

  var cm = pushColMap(sh);
  var now = new Date().toISOString();
  var updated = 0, disabled = 0;

  for (var i = 0; i < results.length; i++) {
    var r = results[i] || {};
    var row = pushFindRow(sh, cm, String(r.endpoint || '').trim());
    if (!row) continue;

    var status = Number(r.status);
    setIfPresent(sh, cm, row, 'LastResult', status);

    if (status >= 200 && status <= 299) {
      setIfPresent(sh, cm, row, 'LastSeen', now);
      setIfPresent(sh, cm, row, 'Fails', 0);
      updated++;
    } else if (status === 404 || status === 410) {
      // Gone for good. Never retry these — the endpoint will never work again.
      setIfPresent(sh, cm, row, 'Disabled', now);
      disabled++;
    } else if (status !== 429) {
      // 429 is the push service asking us to slow down, not a broken
      // subscription, so it must not count as a strike.
      var col = cm.map['Fails'];
      var fails = col === undefined ? 0 : Number(sh.getRange(row, col + 1).getValue() || 0);
      fails = (isNaN(fails) ? 0 : fails) + 1;
      setIfPresent(sh, cm, row, 'Fails', fails);
      if (fails >= 5) { setIfPresent(sh, cm, row, 'Disabled', now); disabled++; }
      updated++;
    }
  }

  logAdmin(ss, 'push_apply', 'ok', updated + ' updated, ' + disabled + ' disabled');
  return { ok: true, updated: updated, disabled: disabled };
}
