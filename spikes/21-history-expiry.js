/**
 * Spike #21: how the Advanced Gmail Service fails for an expired or invalid
 * `startHistoryId`, and how long a saved position stays valid (a daily
 * trigger watches it for at least 7 days). Findings:
 * spikes/21-history-expiry.md.
 *
 * Runnable functions (all prefixed s21_, all take one optional args object):
 *   s21_errors, s21_rawStatus, s21_savePosition, s21_daily,
 *   s21_installTrigger, s21_removeTrigger, s21_report.
 * Helpers end in `_` so they are private (not runnable, not in the editor's
 * dropdown).
 *
 * Script Properties (all prefixed s21.):
 *   s21.positions            [{historyId, savedAt}], newest last, at most 60
 *   s21.results.YYYY-MM-DD   [{checkedAt, historyId, savedAt, ageHours, ok,
 *                              historyCount, errorSummary}] for checks that day
 * Results are split by day because one Script Properties value holds at most
 * 9 KB, too little for 7+ days of checks against a growing list of positions.
 *
 * Trigger: s21_daily, daily at about 09:00 UTC. It is a live trigger:
 * remove it with s21_removeTrigger when the observation ends.
 */

var S21_MAX_POSITIONS = 60;
var S21_RESULT_DAYS_KEPT = 45;

// ---------------------------------------------------------------------------
// Runnable functions
// ---------------------------------------------------------------------------

/**
 * Call History.list for each error case (E1–E7) and return the outcome or
 * the full shape of the exception.
 */
function s21_errors(args) {
  var current = Gmail.Users.getProfile('me').historyId;
  var results = s21_cases_(current).map(function (c) {
    if (c.skip) return { case: c.id, label: c.label, skipped: c.skip };
    var out = { case: c.id, label: c.label, value: c.value };
    try {
      var resp = Gmail.Users.History.list('me', { startHistoryId: c.value, maxResults: 1 });
      out.threw = false;
      out.historyLength = (resp.history || []).length;
      out.responseHistoryId = resp.historyId;
      out.hasNextPageToken = !!resp.nextPageToken;
    } catch (e) {
      out.threw = true;
      out.exception = s21_describe_(e);
    }
    return out;
  });
  return s21_out_({ currentHistoryId: current, at: new Date().toISOString(), results: results });
}

/**
 * Cross-check: the same cases through UrlFetchApp against the REST endpoint,
 * showing the HTTP status and error body behind each exception. Uses the
 * script's own OAuth token (the scopes already declared; no new scope).
 */
function s21_rawStatus(args) {
  var current = Gmail.Users.getProfile('me').historyId;
  var results = s21_cases_(current).map(function (c) {
    if (c.skip) return { case: c.id, label: c.label, skipped: c.skip };
    var url = 'https://gmail.googleapis.com/gmail/v1/users/me/history?maxResults=1&startHistoryId=' +
      encodeURIComponent(c.value);
    var resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    var text = resp.getContentText();
    var body;
    try { body = JSON.parse(text); } catch (e) { body = { unparsed: text.slice(0, 500) }; }
    var out = { case: c.id, label: c.label, value: c.value, httpStatus: resp.getResponseCode() };
    if (body.error) {
      out.error = body.error;
    } else {
      out.historyLength = (body.history || []).length;
      out.responseHistoryId = body.historyId;
      out.hasNextPageToken = !!body.nextPageToken;
    }
    return out;
  });
  return s21_out_({ currentHistoryId: current, at: new Date().toISOString(), results: results });
}

/**
 * Day-0 retention estimate: bisect for the oldest startHistoryId that
 * History.list still accepts (assumes validity is monotonic: everything
 * above the cut-off works), then read internalDate of the messages in the
 * first few messageAdded records after it. Returns IDs, counts, and dates
 * only.
 *
 * args.samples: how many messageAdded messages to date (default 10).
 */
function s21_oldest(args) {
  args = args || {};
  var samples = args.samples || 10;
  var current = Number(Gmail.Users.getProfile('me').historyId);
  var probes = 0;
  var ok = function (id) {
    probes++;
    try {
      Gmail.Users.History.list('me', { startHistoryId: String(id), maxResults: 1 });
      return true;
    } catch (e) {
      if (e && e.details && e.details.code === 404) return false;
      throw e;
    }
  };
  // Invariant: lo is rejected (404), hi is accepted.
  var lo = 1;
  var hi = current;
  if (ok(lo)) return s21_out_({ currentHistoryId: String(current), oldestValid: '1', probes: probes });
  while (hi - lo > 1) {
    var mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid; else lo = mid;
  }

  var dated = [];
  var pageToken = null;
  var pages = 0;
  do {
    var opts = { startHistoryId: String(hi), historyTypes: ['messageAdded'], maxResults: 20 };
    if (pageToken) opts.pageToken = pageToken;
    var resp = Gmail.Users.History.list('me', opts);
    pages++;
    (resp.history || []).forEach(function (h) {
      (h.messagesAdded || []).forEach(function (a) {
        if (dated.length >= samples) return;
        var entry = { recordId: h.id, messageId: a.message.id };
        try {
          var m = Gmail.Users.Messages.get('me', a.message.id, { format: 'minimal' });
          entry.internalDateIso = new Date(Number(m.internalDate)).toISOString();
          entry.ageHours = Math.round((Date.now() - Number(m.internalDate)) / 36e5 * 10) / 10;
        } catch (e) {
          entry.error = { code: e && e.details && e.details.code, message: String(e && e.message).slice(0, 120) };
        }
        dated.push(entry);
      });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken && dated.length < samples && pages < 10);

  return s21_out_({
    at: new Date().toISOString(),
    currentHistoryId: String(current),
    oldestValid: String(hi),
    newestRejected: String(lo),
    idsRetained: current - hi,
    probes: probes,
    firstMessagesAdded: dated
  });
}

/** Append {historyId, savedAt} from getProfile to s21.positions. */
function s21_savePosition(args) {
  var positions = s21_getJson_('s21.positions', []);
  var p = { historyId: Gmail.Users.getProfile('me').historyId, savedAt: new Date().toISOString() };
  positions.push(p);
  while (positions.length > S21_MAX_POSITIONS) positions.shift();
  s21_props_().setProperty('s21.positions', JSON.stringify(positions));
  return s21_out_({ saved: p, positions: positions });
}

/**
 * The trigger handler (also runnable by hand). Saves a new position, then
 * checks every saved position with History.list and appends the results to
 * today's s21.results.YYYY-MM-DD key.
 */
function s21_daily(e) {
  var saved = s21_savePosition().saved;
  var positions = s21_getJson_('s21.positions', []);
  var now = new Date();
  var checkedAt = now.toISOString();
  var entries = positions.map(function (p) {
    var entry = {
      checkedAt: checkedAt,
      historyId: p.historyId,
      savedAt: p.savedAt,
      ageHours: Math.round((now.getTime() - Date.parse(p.savedAt)) / 36e5 * 10) / 10
    };
    try {
      var resp = Gmail.Users.History.list('me', { startHistoryId: String(p.historyId), maxResults: 1 });
      entry.ok = true;
      entry.historyCount = (resp.history || []).length;
      entry.errorSummary = null;
    } catch (err) {
      entry.ok = false;
      entry.historyCount = null;
      entry.errorSummary = {
        code: err && err.details ? err.details.code : null,
        message: String(err && err.message).slice(0, 160)
      };
    }
    console.log(JSON.stringify(entry));
    return entry;
  });

  var key = 's21.results.' + checkedAt.slice(0, 10);
  var today = s21_getJson_(key, []).concat(entries);
  // Stay under the 9 KB value limit if the check runs many times in a day.
  while (today.length > entries.length && JSON.stringify(today).length > 8500) today.shift();
  s21_props_().setProperty(key, JSON.stringify(today));
  s21_pruneResults_();
  return s21_out_({ saved: saved, checked: entries.length, key: key, entries: entries });
}

/** Replace any s21_daily trigger with one that runs daily at about 09:00. */
function s21_installTrigger(args) {
  var removed = s21_deleteDailyTriggers_();
  var t = ScriptApp.newTrigger('s21_daily').timeBased().everyDays(1).atHour(9).create();
  return s21_out_({ triggerId: t.getUniqueId(), removedExisting: removed, triggers: s21_triggerList_() });
}

/** Delete every s21_daily trigger, and return the project's remaining triggers. */
function s21_removeTrigger(args) {
  var removed = s21_deleteDailyTriggers_();
  return s21_out_({ removed: removed, remainingTriggers: s21_triggerList_() });
}

/** Return every saved position and result, plus a summary. */
function s21_report(args) {
  var positions = s21_getJson_('s21.positions', []);
  var keys = s21_props_().getKeys().filter(function (k) { return k.indexOf('s21.results.') === 0; }).sort();
  var results = [];
  keys.forEach(function (k) { results = results.concat(s21_getJson_(k, [])); });

  // Latest check and first failure per position. Keyed by savedAt: on a
  // quiet account, positions saved on different days can share a historyId.
  var byPos = {};
  results.forEach(function (r) {
    var p = byPos[r.savedAt] = byPos[r.savedAt] || { historyId: r.historyId, savedAt: r.savedAt, checks: 0, latest: null, firstFailure: null, lastOk: null };
    p.checks++;
    if (!p.latest || r.checkedAt > p.latest.checkedAt) p.latest = { checkedAt: r.checkedAt, ageHours: r.ageHours, ok: r.ok };
    if (r.ok && (!p.lastOk || r.ageHours > p.lastOk.ageHours)) p.lastOk = { checkedAt: r.checkedAt, ageHours: r.ageHours };
    if (!r.ok && (!p.firstFailure || r.checkedAt < p.firstFailure.checkedAt)) {
      p.firstFailure = { checkedAt: r.checkedAt, ageHours: r.ageHours, errorSummary: r.errorSummary };
    }
  });
  var perPosition = Object.keys(byPos).map(function (k) { return byPos[k]; })
    .sort(function (a, b) { return a.savedAt < b.savedAt ? -1 : 1; });
  var validNow = perPosition.filter(function (p) { return p.latest && p.latest.ok; });
  var oldestValid = validNow.reduce(function (best, p) {
    return !best || p.latest.ageHours > best.ageHours
      ? { historyId: p.historyId, savedAt: p.savedAt, ageHours: p.latest.ageHours, checkedAt: p.latest.checkedAt }
      : best;
  }, null);
  var checkDays = keys.map(function (k) { return k.slice('s21.results.'.length); });

  return s21_out_({
    summary: {
      positions: positions.length,
      checks: results.length,
      checkDays: checkDays,
      oldestValid: oldestValid,
      failures: results.filter(function (r) { return !r.ok; }),
      triggers: s21_triggerList_()
    },
    perPosition: perPosition,
    positions: positions,
    results: results
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The error cases, computed from the current historyId. */
function s21_cases_(current) {
  var cur = Number(current);
  var positions = s21_getJson_('s21.positions', []);
  var dayAgo = Date.now() - 24 * 36e5;
  var old = positions.filter(function (p) { return Date.parse(p.savedAt) <= dayAgo; })[0];
  return [
    { id: 'E1', label: 'very old: 1', value: '1' },
    cur > 1000000
      ? { id: 'E2a', label: 'current - 1,000,000', value: String(cur - 1000000) }
      : { id: 'E2a', label: 'current - 1,000,000', skip: 'current historyId is not above 1,000,000' },
    cur > 100000
      ? { id: 'E2b', label: 'current - 100,000', value: String(cur - 100000) }
      : { id: 'E2b', label: 'current - 100,000', skip: 'current historyId is not above 100,000' },
    { id: 'E3', label: 'non-numeric', value: 'abc' },
    { id: 'E4', label: 'negative', value: '-5' },
    { id: 'E5', label: 'future: current + 1,000,000', value: String(cur + 1000000) },
    { id: 'E6', label: 'current (valid control)', value: String(current) },
    old
      ? { id: 'E7', label: 'saved at ' + old.savedAt, value: String(old.historyId) }
      : { id: 'E7', label: 'saved at least 24 h ago', skip: 'no position in s21.positions is 24 h old yet; rerun later' }
  ];
}

/** Everything observable about an exception from the Advanced Service. */
function s21_describe_(e) {
  var details;
  try { details = JSON.stringify(e.details); } catch (x) { details = 'unserializable: ' + String(x); }
  return {
    name: e && e.name,
    constructorName: e && e.constructor && e.constructor.name,
    string: String(e),
    message: e && e.message,
    details: details === undefined ? null : details,
    keys: e ? Object.keys(e) : [],
    ownPropertyNames: e ? Object.getOwnPropertyNames(e) : [],
    stackFirstLine: e && e.stack ? String(e.stack).split('\n')[0] : null
  };
}

function s21_deleteDailyTriggers_() {
  var removed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 's21_daily') {
      removed.push(t.getUniqueId());
      ScriptApp.deleteTrigger(t);
    }
  });
  return removed;
}

/** All project triggers (handler names only; other spikes' triggers are left alone). */
function s21_triggerList_() {
  return ScriptApp.getProjectTriggers().map(function (t) {
    return { handler: t.getHandlerFunction(), id: t.getUniqueId(), source: String(t.getTriggerSource()) };
  });
}

/** Drop result keys older than S21_RESULT_DAYS_KEPT days. */
function s21_pruneResults_() {
  var cutoff = new Date(Date.now() - S21_RESULT_DAYS_KEPT * 24 * 36e5).toISOString().slice(0, 10);
  s21_props_().getKeys().forEach(function (k) {
    if (k.indexOf('s21.results.') === 0 && k.slice('s21.results.'.length) < cutoff) {
      s21_props_().deleteProperty(k);
    }
  });
}

function s21_props_() {
  return PropertiesService.getScriptProperties();
}

function s21_getJson_(key, fallback) {
  var v = s21_props_().getProperty(key);
  return v ? JSON.parse(v) : fallback;
}

/** Serialize, scrub the test account's address, log, and return. */
function s21_out_(result) {
  var json = JSON.stringify(result);
  var address = Gmail.Users.getProfile('me').emailAddress;
  var at = address.lastIndexOf('@');
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var re = new RegExp(esc(address.slice(0, at)) + '(\\+[^@\\s"<>]*)?@' + esc(address.slice(at + 1)), 'gi');
  json = json.replace(re, function (_, plus) { return '<test-account>' + (plus || ''); });
  console.log(json);
  return JSON.parse(json);
}
