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

function listSheets(ss) {
  var sheets = ss.getSheets().map(function (sh) {
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

/** Ensure the header row exists and contains all INSERT_HEADERS. Returns a map header -> column index (0-based). */
function ensureHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = [];
  if (sheet.getLastRow() >= 1 && lastCol >= 1) {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  }
  var changed = false;
  for (var i = 0; i < INSERT_HEADERS.length; i++) {
    if (headers.indexOf(INSERT_HEADERS[i]) === -1) {
      headers.push(INSERT_HEADERS[i]);
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

  var colMap = ensureHeaders(sheet);

  // Build a value map keyed by header name.
  var valueFor = {
    'Rank': params.rank,
    'Commander': params.commander,
    'Tier': params.tier,
    'Power': params.power,
    'Donation': params.donation,
    'Kills': params.kills
  };

  function coerce(key, val) {
    if (val === undefined || val === null || val === '') return null;
    if (key === 'Rank' || key === 'Power' || key === 'Donation' || key === 'Kills') {
      var n = Number(val);
      return isNaN(n) ? val : n;
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
