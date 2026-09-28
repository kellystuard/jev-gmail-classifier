/**
 * Spike for E3 (#62): can `users.history.list` resume from a history
 * **record's** `id` (not only from a `historyId` returned by getProfile or a
 * list response)? And what does the 404 for a discarded position look like
 * through the Advanced Service?
 *
 * E3's ingest stops at the queue cap part-way through history. If it can
 * save the last fully queued record's `id` as the new position, the next run
 * resumes right after it instead of re-reading history it already queued.
 *
 * Runnable functions (prefixed s62_, one optional args object):
 *   s62_run      inserts 4 messages (new threads), then lists and resumes.
 *   s62_cleanup  trashes the messages s62_run inserted.
 *
 * The test account's address is used only to address messages and is
 * scrubbed from every result (`<test-account>`).
 */

var S62_PREFIX = 'E3-62-';

function s62_run(args) {
  args = args || {};
  var ctx = s62_ctx_();
  var start = Gmail.Users.getProfile('me').historyId;
  var inserted = [];
  for (var i = 1; i <= 4; i++) {
    inserted.push(s62_insert_(ctx, 'm' + i));
    Utilities.sleep(1500);
  }
  PropertiesService.getScriptProperties().setProperty('s62.ids', JSON.stringify(inserted.map(function (m) { return m.id; })));
  Utilities.sleep(3000);

  var ours = {};
  inserted.forEach(function (m, n) { ours[m.id] = 'm' + (n + 1); });

  var fromStart = s62_list_(start, ours);
  // Records that added one of our messages, in order.
  var added = fromStart.records.filter(function (r) { return r.ours.length > 0; });
  var result = {
    start: start,
    inserted: inserted.map(function (m, n) { return { tag: 'm' + (n + 1), id: m.id, threadId: m.threadId }; }),
    fromStart: fromStart,
    resumes: []
  };

  // Resume from each of our records' ids, and from a bare record's id.
  added.forEach(function (r) {
    var resumed = s62_list_(r.id, ours);
    result.resumes.push({
      from: r.id,
      fromTag: r.ours.join(','),
      ok: resumed.ok,
      error: resumed.error,
      includesStartRecord: resumed.records.some(function (x) { return x.id === r.id; }),
      recordIds: resumed.records.map(function (x) { return x.id; }),
      oursInOrder: resumed.records.filter(function (x) { return x.ours.length > 0; }).map(function (x) { return x.ours.join(','); }),
      allAfterStart: resumed.records.every(function (x) { return s62_gt_(x.id, r.id); }),
      historyId: resumed.lastHistoryId
    });
  });
  var bare = fromStart.records.filter(function (r) { return r.bare; })[0];
  if (bare) {
    var fromBare = s62_list_(bare.id, ours);
    result.resumeFromBare = {
      from: bare.id,
      ok: fromBare.ok,
      error: fromBare.error,
      oursInOrder: fromBare.records.filter(function (x) { return x.ours.length > 0; }).map(function (x) { return x.ours.join(','); }),
      allAfterStart: fromBare.records.every(function (x) { return s62_gt_(x.id, bare.id); })
    };
  }

  // A position Gmail has certainly discarded, and one in the future.
  result.expired = s62_tryList_('1');
  result.future = s62_tryList_(String(s62_add_(start, 100000000)));
  return s62_out_(result, ctx);
}

function s62_cleanup(args) {
  var ids = JSON.parse(PropertiesService.getScriptProperties().getProperty('s62.ids') || '[]');
  var done = ids.map(function (id) {
    try {
      Gmail.Users.Messages.trash('me', id);
      return { id: id, trashed: true };
    } catch (e) {
      return { id: id, error: String(e && e.message) };
    }
  });
  return s62_out_({ trashed: done }, null);
}

// ---------------------------------------------------------------------------

function s62_list_(startHistoryId, ours) {
  var records = [];
  var pageToken;
  var lastHistoryId;
  var pages = 0;
  try {
    do {
      var opts = { startHistoryId: startHistoryId, historyTypes: ['messageAdded'], maxResults: 2 };
      if (pageToken) opts.pageToken = pageToken;
      var resp = Gmail.Users.History.list('me', opts);
      pages++;
      lastHistoryId = resp.historyId;
      (resp.history || []).forEach(function (h) {
        var tags = (h.messagesAdded || []).map(function (a) { return ours[a.message.id]; }).filter(function (t) { return t; });
        records.push({ id: h.id, bare: !h.messagesAdded, ours: tags });
      });
      pageToken = resp.nextPageToken;
    } while (pageToken && pages < 50);
    return { ok: true, pages: pages, lastHistoryId: lastHistoryId, records: records };
  } catch (e) {
    return { ok: false, error: s62_err_(e), records: records };
  }
}

function s62_tryList_(startHistoryId) {
  try {
    var resp = Gmail.Users.History.list('me', { startHistoryId: startHistoryId, historyTypes: ['messageAdded'], maxResults: 1 });
    return { ok: true, keys: Object.keys(resp).sort(), historyId: resp.historyId, count: (resp.history || []).length };
  } catch (e) {
    return { ok: false, error: s62_err_(e) };
  }
}

function s62_ctx_() {
  var address = Gmail.Users.getProfile('me').emailAddress;
  return { address: address, run: Date.now().toString(36) };
}

function s62_insert_(ctx, tag) {
  var raw = [
    'From: sender-' + tag + '@example.com',
    'To: ' + ctx.address,
    'Subject: ' + S62_PREFIX + tag + ' [' + ctx.run + ']',
    'Date: ' + Utilities.formatDate(new Date(), 'Etc/UTC', 'EEE, dd MMM yyyy HH:mm:ss Z'),
    'Message-ID: <e3-62-' + tag + '-' + Date.now() + '@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Synthetic test message for the E3 #62 spike (' + tag + ').\r\n'
  ].join('\r\n');
  var blob = Utilities.newBlob(raw, 'message/rfc822');
  var m = Gmail.Users.Messages.insert({ labelIds: ['INBOX', 'UNREAD'] }, 'me', blob);
  if (!m.threadId) m = Gmail.Users.Messages.get('me', m.id, { format: 'minimal' });
  return { id: m.id, threadId: m.threadId };
}

function s62_err_(e) {
  return { name: e && e.name, message: String(e && e.message), code: e && e.details && e.details.code, details: e && e.details ? JSON.stringify(e.details) : undefined };
}

/** Compare decimal historyId strings numerically (they can exceed 2^53). */
function s62_gt_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

/** Add a small integer to a decimal string. */
function s62_add_(a, n) {
  var digits = String(a).split('').map(Number);
  var carry = n;
  for (var i = digits.length - 1; i >= 0 && carry > 0; i--) {
    var sum = digits[i] + carry;
    digits[i] = sum % 10;
    carry = Math.floor(sum / 10);
  }
  var out = digits.join('');
  return carry > 0 ? String(carry) + out : out;
}

function s62_out_(result, ctx) {
  var json = JSON.stringify(result);
  var address = ctx ? ctx.address : Gmail.Users.getProfile('me').emailAddress;
  var at = address.lastIndexOf('@');
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var re = new RegExp(esc(address.slice(0, at)) + '(\\+[^@\\s"<>]*)?@' + esc(address.slice(at + 1)), 'gi');
  json = json.replace(re, function (_, plus) { return '<test-account>' + (plus || ''); });
  console.log(json);
  return JSON.parse(json);
}
