/**
 * Xərc storage script
 * -------------------
 * 1. Open your Google Sheet → Extensions → Apps Script.
 * 2. Delete everything in Code.gs and paste this whole file.
 * 3. Change SECRET below to the same text as APPS_SCRIPT_SECRET in your .env file.
 * 4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 * 5. Copy the Web app URL (ends with /exec) into APPS_SCRIPT_URL in .env.
 *
 * After changing this code later: Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy.
 */
const SECRET = 'galatasaray';

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'Bad request' });
  }
  if (!SECRET || SECRET === 'CHANGE-ME') return out_({ ok: false, error: 'Set SECRET in the Apps Script code and deploy a new version' });
  if (req.secret !== SECRET) return out_({ ok: false, error: 'Wrong secret: APPS_SCRIPT_SECRET in .env must equal SECRET in the Apps Script' });

  const fn = ACTIONS[req.action];
  if (!fn) return out_({ ok: false, error: 'Unknown action: ' + req.action });

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    return out_({ ok: true, result: fn(req) });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return out_({ ok: true, result: 'Xərc storage is running. The app talks to this URL with POST requests.' });
}

/* ---------- helpers ---------- */
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function book_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}
function sheet_(name) {
  const s = book_().getSheetByName(name);
  if (!s) throw new Error('Sheet tab not found: ' + name);
  return s;
}
function norm_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}
function cell_(v) {
  return v instanceof Date ? Utilities.formatDate(v, book_().getSpreadsheetTimeZone(), "yyyy-MM-dd'T'HH:mm:ss") : v;
}
// Text that starts with = + - @ would become a formula; store it as plain text.
function safe_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}
function padRow_(row, width) {
  const r = row.slice(0, width);
  while (r.length < width) r.push('');
  return r.map(safe_);
}
function findRow_(s, col, key) {
  const last = s.getLastRow();
  if (last < 2) return -1;
  const vals = s.getRange(2, col, last - 1, 1).getValues();
  const k = norm_(key);
  for (let i = 0; i < vals.length; i++) if (norm_(vals[i][0]) === k) return i + 2;
  return -1;
}

/* ---------- actions ---------- */
const ACTIONS = {
  // Create missing tabs with headers and starter rows.
  setup: function (req) {
    const created = [];
    Object.keys(req.sheets).forEach(function (name) {
      const def = req.sheets[name];
      let s = book_().getSheetByName(name);
      if (!s) {
        s = book_().insertSheet(name);
        created.push(name);
      }
      if (s.getLastRow() === 0) {
        const width = def.headers.length;
        (def.textColumns || []).forEach(function (c) {
          s.getRange(1, c, s.getMaxRows(), 1).setNumberFormat('@');
        });
        const rows = [def.headers].concat(def.defaults || []).map(function (r) { return padRow_(r, width); });
        s.getRange(1, 1, rows.length, width).setValues(rows);
        s.setFrozenRows(1);
        s.getRange(1, 1, 1, width).setFontWeight('bold');
      }
    });
    return { title: book_().getName(), created: created };
  },

  // All data rows of a tab. Rows typed by hand without an id get one.
  read: function (req) {
    const s = sheet_(req.sheet);
    const last = s.getLastRow();
    if (last < 2) return [];
    const width = req.width || s.getLastColumn();
    const vals = s.getRange(2, 1, last - 1, width).getValues();
    if (req.fillIds) {
      let changed = false;
      vals.forEach(function (r) {
        if (r.join('') !== '' && String(r[0]).trim() === '') {
          r[0] = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
          changed = true;
        }
      });
      if (changed) s.getRange(2, 1, vals.length, 1).setValues(vals.map(function (r) { return [r[0]]; }));
    }
    return vals
      .filter(function (r) { return r.join('') !== ''; })
      .map(function (r) { return r.map(cell_); });
  },

  append: function (req) {
    const s = sheet_(req.sheet);
    const row = padRow_(req.row, req.row.length);
    s.getRange(s.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    return true;
  },

  // Replace the row whose column `col` equals `key`. Returns the old row or null.
  updateWhere: function (req) {
    const s = sheet_(req.sheet);
    const r = findRow_(s, req.col || 1, req.key);
    if (r < 0) return null;
    const width = req.row.length;
    const old = s.getRange(r, 1, 1, width).getValues()[0].map(cell_);
    s.getRange(r, 1, 1, width).setValues([padRow_(req.row, width)]);
    return old;
  },

  // Delete the row whose column `col` equals `key`. Returns the old row or null.
  deleteWhere: function (req) {
    const s = sheet_(req.sheet);
    const r = findRow_(s, req.col || 1, req.key);
    if (r < 0) return null;
    const old = s.getRange(r, 1, 1, s.getLastColumn()).getValues()[0].map(cell_);
    s.deleteRow(r);
    return old;
  },

  // Change every cell in column `col` equal to `from` into `to`. Returns how many changed.
  renameInColumn: function (req) {
    const s = sheet_(req.sheet);
    const last = s.getLastRow();
    if (last < 2) return 0;
    const range = s.getRange(2, req.col, last - 1, 1);
    const vals = range.getValues();
    const k = norm_(req.from);
    let n = 0;
    vals.forEach(function (r) {
      if (norm_(r[0]) === k) { r[0] = req.to; n++; }
    });
    if (n) range.setValues(vals.map(function (r) { return [safe_(r[0])]; }));
    return n;
  },

  // Replace the whole tab (headers + rows).
  replaceAll: function (req) {
    const s = sheet_(req.sheet);
    s.clearContents();
    const width = req.rows[0].length;
    s.getRange(1, 1, req.rows.length, width).setValues(req.rows.map(function (r) { return padRow_(r, width); }));
    return true;
  }
};
