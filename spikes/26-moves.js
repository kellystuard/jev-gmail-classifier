/**
 * Spike #26: archive, spam, trash, and move-to-label through threads.modify
 * and threads.trash, and whether adding SPAM reports the sender.
 *
 * Test threads:
 * - Imported ("received"): one per case below, from placeholder addresses on
 *   example.test. S3 and T5 also get an imported reply labelled SENT whose
 *   From is the test account (read at run time, never returned).
 * - Self-sent (the R cases): sent from the test account to its own
 *   plus-address (<test-account>+s26) with Messages.send.
 *
 * State shared between runs lives in Script Properties under s26.*. Every
 * result is scrubbed of email addresses other than placeholders on
 * example.test.
 *
 * Run order (see spikes/26-moves.md): s26_setup, s26_applyMoves,
 * s26_repeatMoves, s26_listOwnHistory, s26_importReplies; s26_sendReal,
 * (wait a minute) s26_applyRealMoves, s26_sendReplies, s26_sendFollowUp;
 * (maintainer observes and reports U1 as spam) s26_spamFollowUp;
 * (wait 10+ minutes) s26_inspect; s26_cleanup.
 */

var S26_MAX_TEXT = 600;
var S26_PLUS_TAG = 's26';

/** Imported cases: From address and whether a synthetic SENT reply is added. */
var S26_IMPORTED = {
  A1: { from: 's26-a1@example.test' },
  L1: { from: 's26-l1@example.test' },
  L2: { from: 's26-l2@example.test' },
  S1: { from: 's26-s1@example.test' },
  S2: { from: 's26-x@example.test' }, // X: API-spammed sender
  S3: { from: 's26-s3@example.test', withSent: true },
  T1: { from: 's26-t1@example.test' },
  T2: { from: 's26-t2@example.test' },
  T3: { from: 's26-t3@example.test' },
  T4: { from: 's26-t4@example.test' },
  T5: { from: 's26-t5@example.test', withSent: true },
  U1: { from: 's26-y@example.test' } // Y: reported with the UI's "Report spam" by the maintainer
};
var S26_FOLLOW_UP_FROM = { X: 's26-x@example.test', Y: 's26-y@example.test', Z: 's26-z@example.test' };
var S26_REAL = ['RA', 'RL', 'RS', 'RT'];

var s26_addressCache_ = null;

// ---------------------------------------------------------------------------
// Runnable functions
// ---------------------------------------------------------------------------

/** Create S26 labels, import the test threads, save the history ID. */
function s26_setup() {
  var result = { fn: 's26_setup', at: new Date().toISOString() };
  result.labels = s26_ensureLabels_();
  var threads = s26_threads_();
  var spamOnImport = s26_get_('spamOnImport', []);
  result.cases = {};

  Object.keys(S26_IMPORTED).forEach(function (name) {
    var spec = S26_IMPORTED[name];
    var c = { from: spec.from, attempts: [] };
    var messageId = s26_newMessageId_(name);
    var raw = s26_raw_({
      from: 'S26 ' + name + ' <' + spec.from + '>',
      to: 'S26 Recipient <s26-to@example.test>',
      subject: 'S26-' + name,
      messageId: messageId,
      body: 'Synthetic message for spike #26, case ' + name + '.'
    });
    var imp = s26_import_(raw, { labelIds: ['INBOX', 'UNREAD'] }, false);
    c.attempts.push(imp);
    if (imp.ok && s26_hasSpam_(imp)) {
      spamOnImport.push(imp.threadId);
      var retryId = s26_newMessageId_(name + 'r');
      raw = raw.replace(messageId, retryId);
      messageId = retryId;
      imp = s26_import_(raw, { labelIds: ['INBOX', 'UNREAD'] }, true);
      c.attempts.push(imp);
      c.reimportedWithNeverMarkSpam = true;
    }
    if (!imp.ok) {
      result.cases[name] = c;
      return;
    }
    var entry = { threadId: imp.threadId, created: 'import', from: spec.from, messages: [{ id: imp.id, role: 'original (import)', messageIdHeader: messageId }] };

    if (spec.withSent) {
      var me = s26_address_();
      var replyId = s26_newMessageId_(name + '-sent');
      var sentRaw = s26_raw_({
        from: me,
        to: 'S26 ' + name + ' <' + spec.from + '>',
        subject: 'Re: S26-' + name,
        messageId: replyId,
        inReplyTo: messageId,
        body: 'Synthetic sent reply for spike #26, case ' + name + '.'
      });
      var sent = s26_import_(sentRaw, { labelIds: ['SENT'], threadId: imp.threadId }, true);
      c.sentReply = sent;
      if (sent.ok) {
        entry.created = 'import + synthetic SENT reply (import)';
        entry.messages.push({ id: sent.id, role: 'sent reply (import, synthetic SENT)', messageIdHeader: replyId });
        c.sentReplyJoinedThread = sent.threadId === imp.threadId;
      }
    }
    threads[name] = entry;
    c.threadId = entry.threadId;
    c.snapshot = s26_snapshot_(name, entry);
    result.cases[name] = c;
  });

  s26_saveThreads_(threads);
  s26_set_('spamOnImport', spamOnImport);
  result.spamOnImport = spamOnImport;
  var h = s26_try_(function () { return String(Gmail.Users.getProfile('me').historyId); });
  if (h.ok) s26_set_('historyStart', h.value);
  result.historyStart = h;
  return s26_out_(result);
}

/** A1, L1, L2, S1, S2, S3, T1–T5: apply each action, recording labelIds before and after. */
function s26_applyMoves() {
  var result = { fn: 's26_applyMoves', at: new Date().toISOString() };
  var h = s26_try_(function () { return String(Gmail.Users.getProfile('me').historyId); });
  if (h.ok) s26_set_('historyBeforeMoves', h.value);
  result.historyBeforeMoves = h;
  var L = s26_get_('labels', {});
  result.labels = L;
  result.cases = s26_runActions_(s26_actions_(L), ['A1', 'L1', 'L2', 'S1', 'S2', 'S3', 'T1', 'T2', 'T3', 'T4', 'T5']);
  return s26_out_(result);
}

/** I1: repeat the actions on A1, L1, S2, T1. */
function s26_repeatMoves() {
  var result = { fn: 's26_repeatMoves', at: new Date().toISOString() };
  var h = s26_try_(function () { return String(Gmail.Users.getProfile('me').historyId); });
  if (h.ok) s26_set_('historyBeforeRepeat', h.value);
  result.historyBeforeRepeat = h;
  var L = s26_get_('labels', {});
  result.labels = L;
  result.cases = s26_runActions_(s26_actions_(L), ['A1', 'L1', 'S2', 'T1']);
  return s26_out_(result);
}

/** H1: history records since the ID saved at the start of s26_applyMoves. */
function s26_listOwnHistory() {
  var result = { fn: 's26_listOwnHistory', at: new Date().toISOString() };
  var start = s26_get_('historyBeforeMoves', null) || s26_get_('historyStart', null);
  var repeatFrom = s26_get_('historyBeforeRepeat', null);
  result.startHistoryId = start;
  result.repeatHistoryId = repeatFrom;
  if (!start) {
    result.error = 'No saved history ID: run s26_setup and s26_applyMoves first.';
    return s26_out_(result);
  }
  var byThread = s26_threadToCase_();
  var L = s26_get_('labels', {});
  var names = {};
  Object.keys(L).forEach(function (k) { names[L[k]] = 'S26/' + k; });
  var mapLabels = function (ids) { return (ids || []).map(function (id) { return names[id] || id; }); };

  var records = [];
  var foreign = 0;
  var typeCounts = {};
  var listed = s26_try_(function () {
    var pageToken = null;
    var pages = 0;
    do {
      var opts = { startHistoryId: start, maxResults: 500 };
      if (pageToken) opts.pageToken = pageToken;
      var resp = Gmail.Users.History.list('me', opts);
      (resp.history || []).forEach(function (rec) {
        var types = Object.keys(rec).filter(function (k) { return k !== 'id' && k !== 'messages'; });
        var tids = {};
        (rec.messages || []).forEach(function (m) { tids[m.threadId] = true; });
        var summary = { id: rec.id, types: types, cases: [] };
        if (repeatFrom) {
          summary.phase = s26_cmpId_(rec.id, repeatFrom) > 0 ? 'repeat or later' : 'moves';
        }
        ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'].forEach(function (k) {
          if (!rec[k]) return;
          summary[k] = rec[k].map(function (x) {
            var m = x.message || {};
            tids[m.threadId] = true;
            var item = { case: byThread[m.threadId] || null, messageId: m.id };
            if (x.labelIds) item.changed = mapLabels(x.labelIds);
            item.labelIdsNow = mapLabels(m.labelIds);
            return item;
          });
        });
        summary.cases = Object.keys(tids).map(function (t) { return byThread[t] || null; });
        var ours = summary.cases.some(function (c) { return c !== null; });
        if (!ours) {
          foreign++;
          return;
        }
        types.forEach(function (t) { typeCounts[t] = (typeCounts[t] || 0) + 1; });
        records.push(summary);
      });
      pageToken = resp.nextPageToken || null;
      pages++;
    } while (pageToken && pages < 20);
    return { pages: pages };
  });
  result.list = listed;
  result.typeCounts = typeCounts;
  result.messagesAddedOnOurThreads = typeCounts.messagesAdded || 0;
  result.foreignRecords = foreign;
  result.records = records;
  return s26_out_(result);
}

/** RI: import a reply with no labelIds into A1, L1, S2, T1. Where does import put it? */
function s26_importReplies() {
  var result = { fn: 's26_importReplies', at: new Date().toISOString(), cases: {} };
  var threads = s26_threads_();
  ['A1', 'L1', 'S2', 'T1'].forEach(function (name) {
    var entry = threads[name];
    if (!entry) { result.cases[name] = { error: 'no thread for ' + name }; return; }
    var original = entry.messages[0];
    var replyId = s26_newMessageId_(name + '-ri');
    var raw = s26_raw_({
      from: 'S26 ' + name + ' <' + entry.from + '>',
      to: 'S26 Recipient <s26-to@example.test>',
      subject: 'Re: S26-' + name,
      messageId: replyId,
      inReplyTo: original.messageIdHeader,
      body: 'Synthetic imported reply for spike #26, case RI on ' + name + '.'
    });
    var c = { before: s26_snapshot_(name, entry) };
    c.import = s26_import_(raw, { threadId: entry.threadId }, false);
    if (c.import.ok) {
      c.joinedThread = c.import.threadId === entry.threadId;
      entry.messages.push({ id: c.import.id, role: 'RI reply (import, no labelIds)', messageIdHeader: replyId });
    }
    c.after = s26_snapshot_(name, entry);
    result.cases[name] = c;
  });
  s26_saveThreads_(threads);
  return s26_out_(result);
}

/**
 * Spam evidence, step 3: import a fresh neutral message from X (S2's From,
 * API-spammed), Y (U1's From, UI-reported), and Z (no action), with
 * neverMarkSpam false and no labelIds. Run after the maintainer reports U1.
 */
function s26_spamFollowUp() {
  var result = { fn: 's26_spamFollowUp', at: new Date().toISOString(), messages: {} };
  var follow = s26_get_('followUp', {});
  follow.imports = follow.imports || {};
  var threads = s26_threads_();
  if (threads.U1) result.u1Now = s26_snapshot_('U1', threads.U1);
  Object.keys(S26_FOLLOW_UP_FROM).forEach(function (who) {
    var from = S26_FOLLOW_UP_FROM[who];
    var messageId = s26_newMessageId_('fu-' + who);
    var raw = s26_raw_({
      from: 'S26 ' + who + ' <' + from + '>',
      to: 'S26 Recipient <s26-to@example.test>',
      subject: 'Thursday',
      messageId: messageId,
      body: 'Hi, are we still on for Thursday at noon? Thanks.'
    });
    var imp = s26_import_(raw, {}, false);
    result.messages[who] = { from: from, import: imp };
    if (imp.ok) {
      follow.imports[who] = { id: imp.id, threadId: imp.threadId, from: from };
      threads['FU-' + who] = { threadId: imp.threadId, created: 'import (follow-up)', from: from, messages: [{ id: imp.id, role: 'follow-up (import, no labelIds)' }] };
    }
  });
  follow.importedAt = result.at;
  s26_set_('followUp', follow);
  s26_saveThreads_(threads);
  return s26_out_(result);
}

/** R setup: self-send S26-RA, -RL, -RS, -RT from the test account to <test-account>+s26. */
function s26_sendReal() {
  var result = { fn: 's26_sendReal', at: new Date().toISOString(), cases: {} };
  var threads = s26_threads_();
  S26_REAL.forEach(function (name) {
    var sent = s26_send_('S26-' + name, 'Self-sent message for spike #26, case ' + name + '.', null, null);
    result.cases[name] = sent;
    if (sent.ok) {
      threads[name] = { threadId: sent.threadId, created: 'self-send', from: '<test-account>', messages: [{ id: sent.id, role: 'original (self-send)' }] };
    }
  });
  s26_saveThreads_(threads);
  return s26_out_(result);
}

/** R moves: RA archive, RL move to S26/Moved, RS spam, RT trash. */
function s26_applyRealMoves() {
  var result = { fn: 's26_applyRealMoves', at: new Date().toISOString() };
  var L = s26_get_('labels', {});
  result.labels = L;
  result.cases = s26_runActions_(s26_actions_(L), S26_REAL);
  return s26_out_(result);
}

/** R1–R3: self-send a reply into each R thread after its move. */
function s26_sendReplies() {
  var result = { fn: 's26_sendReplies', at: new Date().toISOString(), cases: {} };
  var threads = s26_threads_();
  S26_REAL.forEach(function (name) {
    var entry = threads[name];
    if (!entry) { result.cases[name] = { error: 'no thread for ' + name + ': run s26_sendReal first' }; return; }
    var c = { before: s26_snapshot_(name, entry) };
    var header = s26_try_(function () {
      var m = Gmail.Users.Messages.get('me', entry.messages[0].id, { format: 'metadata', metadataHeaders: ['Message-ID'] });
      var h = ((m.payload && m.payload.headers) || []).filter(function (x) { return /^message-id$/i.test(x.name); })[0];
      if (!h) throw new Error('original has no Message-ID header');
      return h.value;
    });
    c.originalMessageIdFound = header.ok;
    if (!header.ok) {
      c.headerError = header.error;
      result.cases[name] = c;
      return;
    }
    c.send = s26_send_('Re: S26-' + name, 'Self-sent reply for spike #26, case ' + name + '.', entry.threadId, header.value);
    if (c.send.ok) {
      c.joinedThread = c.send.threadId === entry.threadId;
      entry.messages.push({ id: c.send.id, role: 'reply (self-send)' });
    }
    c.after = s26_snapshot_(name, entry);
    result.cases[name] = c;
  });
  s26_saveThreads_(threads);
  return s26_out_(result);
}

/** Spam evidence, step 4: self-send a fresh neutral message after RS was spammed. */
function s26_sendFollowUp() {
  var result = { fn: 's26_sendFollowUp', at: new Date().toISOString() };
  var threads = s26_threads_();
  var follow = s26_get_('followUp', {});
  result.send = s26_send_('Thursday', 'Hi, are we still on for Thursday at noon? Thanks.', null, null);
  if (result.send.ok) {
    threads['FU-self'] = { threadId: result.send.threadId, created: 'self-send (follow-up)', from: '<test-account>', messages: [{ id: result.send.id, role: 'follow-up (self-send)' }] };
    follow.sentAt = result.at;
  }
  s26_saveThreads_(threads);
  s26_set_('followUp', follow);
  return s26_out_(result);
}

/** Per-message labelIds of every tracked thread, with minutes since the follow-ups. */
function s26_inspect() {
  var now = new Date();
  var result = { fn: 's26_inspect', at: now.toISOString() };
  var follow = s26_get_('followUp', {});
  var mins = function (iso) { return iso ? Math.round((now - new Date(iso)) / 60000) : null; };
  result.minutesSinceFollowUpImport = mins(follow.importedAt);
  result.minutesSinceFollowUpSend = mins(follow.sentAt);
  result.labels = s26_get_('labels', {});
  var threads = s26_threads_();
  result.threads = {};
  Object.keys(threads).forEach(function (name) {
    result.threads[name] = { created: threads[name].created, messages: s26_snapshot_(name, threads[name]) };
  });
  return s26_out_(result);
}

/** Un-spam (remove SPAM, add INBOX), untrash, delete the S26 labels. Clears s26.* only if nothing failed. */
function s26_cleanup() {
  var result = { fn: 's26_cleanup', at: new Date().toISOString(), threads: {}, failed: 0 };
  var threads = s26_threads_();
  var extra = s26_get_('spamOnImport', []);
  var all = {};
  Object.keys(threads).forEach(function (k) { all[k] = threads[k].threadId; });
  extra.forEach(function (tid, i) { all['spamOnImport' + i] = tid; });

  Object.keys(all).forEach(function (name) {
    var tid = all[name];
    var r = {};
    var snap = s26_try_(function () {
      var t = Gmail.Users.Threads.get('me', tid, { format: 'minimal' });
      return (t.messages || []).map(function (m) { return m.labelIds || []; });
    });
    if (!snap.ok) { r.get = snap; result.failed++; result.threads[name] = r; return; }
    var hasSpam = snap.value.some(function (ids) { return ids.indexOf('SPAM') !== -1; });
    var hasTrash = snap.value.some(function (ids) { return ids.indexOf('TRASH') !== -1; });
    if (hasSpam) {
      r.unspam = s26_try_(function () {
        Gmail.Users.Threads.modify({ addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] }, 'me', tid);
        return 'ok';
      });
      if (!r.unspam.ok) result.failed++;
    }
    if (hasTrash) {
      r.untrash = s26_try_(function () { Gmail.Users.Threads.untrash('me', tid); return 'ok'; });
      if (!r.untrash.ok) result.failed++;
    }
    result.threads[name] = r;
  });

  var L = s26_get_('labels', {});
  result.labelsDeleted = {};
  ['Tag', 'Moved', 'parent'].forEach(function (k) {
    if (!L[k]) return;
    var r = s26_try_(function () { s26_removeLabel_(L[k]); return 'ok'; });
    result.labelsDeleted[k] = r;
    if (!r.ok) result.failed++;
  });
  result.remainingS26Labels = s26_try_(function () {
    return (Gmail.Users.Labels.list('me').labels || []).filter(function (l) {
      return /^s26(\/|$)/i.test(l.name);
    }).map(function (l) { return l.name; });
  });
  if (result.failed === 0) {
    var props = PropertiesService.getScriptProperties();
    var keys = Object.keys(props.getProperties()).filter(function (k) { return k.indexOf('s26.') === 0; });
    keys.forEach(function (k) { props.deleteProperty(k); });
    result.deletedPropertyKeys = keys.length;
  } else {
    result.note = 'Something failed: s26.* properties kept so cleanup can be re-run.';
  }
  return s26_out_(result);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The action per case, as a list of calls. L holds the S26 label IDs. */
function s26_actions_(L) {
  var modify = function (add, remove) {
    var resource = {};
    if (add && add.length) resource.addLabelIds = add;
    if (remove && remove.length) resource.removeLabelIds = remove;
    return { call: 'threads.modify ' + JSON.stringify(s26_named_(resource, L)), run: function (tid) {
      var t = Gmail.Users.Threads.modify(resource, 'me', tid);
      return { id: t.id };
    } };
  };
  var trash = { call: 'threads.trash', run: function (tid) {
    var t = Gmail.Users.Threads.trash('me', tid);
    return { id: t.id };
  } };
  return {
    A1: [modify(null, ['INBOX'])],
    L1: [modify([L.Moved], ['INBOX'])],
    L2: [modify([L.Tag, L.Moved], ['INBOX'])],
    S1: [modify(['SPAM'], null)],
    S2: [modify(['SPAM', L.Tag], ['INBOX'])],
    S3: [modify(['SPAM', L.Tag], ['INBOX'])],
    T1: [trash],
    T2: [modify(['TRASH'], null)],
    T3: [modify([L.Tag], null), trash],
    T4: [trash, modify([L.Tag], null)],
    T5: [trash],
    RA: [modify(null, ['INBOX'])],
    RL: [modify([L.Moved], ['INBOX'])],
    RS: [modify(['SPAM'], ['INBOX'])],
    RT: [trash]
  };
}

function s26_runActions_(actions, names) {
  var threads = s26_threads_();
  var out = {};
  names.forEach(function (name) {
    var entry = threads[name];
    if (!entry) { out[name] = { error: 'no thread for ' + name }; return; }
    var c = { before: s26_snapshot_(name, entry), calls: [] };
    actions[name].forEach(function (a) {
      c.calls.push({ call: a.call, result: s26_try_(function () { return a.run(entry.threadId); }) });
    });
    c.after = s26_snapshot_(name, entry);
    out[name] = c;
  });
  return out;
}

/** The resource with S26 label IDs shown by name, for readable results. */
function s26_named_(resource, L) {
  var names = {};
  Object.keys(L).forEach(function (k) { names[L[k]] = 'S26/' + k; });
  var map = function (ids) { return ids.map(function (id) { return names[id] ? names[id] + ' (' + id + ')' : id; }); };
  var out = {};
  if (resource.addLabelIds) out.addLabelIds = map(resource.addLabelIds);
  if (resource.removeLabelIds) out.removeLabelIds = map(resource.removeLabelIds);
  return out;
}

// ---------------------------------------------------------------------------
// Helpers (trailing underscore: hidden from the editor dropdown and scripts.run)
// ---------------------------------------------------------------------------

/** Ensure S26, S26/Moved, S26/Tag exist; store and return their IDs. */
function s26_ensureLabels_() {
  var out = {};
  var r = s26_try_(function () {
    var existing = {};
    (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) { existing[l.name] = l.id; });
    var want = { parent: 'S26', Moved: 'S26/Moved', Tag: 'S26/Tag' };
    Object.keys(want).forEach(function (k) {
      var name = want[k];
      out[k] = existing[name] || Gmail.Users.Labels.create(
        { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, 'me').id;
    });
    return out;
  });
  if (r.ok) s26_set_('labels', out);
  return r;
}

/** Per-message {id, role, labelIds} for a tracked thread (format: minimal). */
function s26_snapshot_(name, entry) {
  var roles = {};
  (entry.messages || []).forEach(function (m) { roles[m.id] = m.role; });
  var r = s26_try_(function () {
    var t = Gmail.Users.Threads.get('me', entry.threadId, { format: 'minimal' });
    return (t.messages || []).map(function (m) {
      return { id: m.id, role: roles[m.id] || '(untracked)', labelIds: m.labelIds || [] };
    });
  });
  return r.ok ? r.value : r;
}

function s26_hasSpam_(imp) {
  return (imp.labelIds || []).indexOf('SPAM') !== -1;
}

function s26_threadToCase_() {
  var threads = s26_threads_();
  var map = {};
  Object.keys(threads).forEach(function (k) { map[threads[k].threadId] = k; });
  return map;
}

/** Compare two history IDs (decimal strings of up to 64 bits). */
function s26_cmpId_(a, b) {
  var x = BigInt(a);
  var y = BigInt(b);
  return x > y ? 1 : x < y ? -1 : 0;
}

/** The test account's address, read at run time. Never returned: s26_out_ scrubs it. */
function s26_address_() {
  if (!s26_addressCache_) s26_addressCache_ = Gmail.Users.getProfile('me').emailAddress;
  return s26_addressCache_;
}

function s26_plusAddress_() {
  var a = s26_address_();
  var at = a.lastIndexOf('@');
  return a.slice(0, at) + '+' + S26_PLUS_TAG + a.slice(at);
}

function s26_newMessageId_(tag) {
  return '<s26-' + tag + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '@example.test>';
}

/** Build an RFC 822 message. */
function s26_raw_(m) {
  var lines = [
    'From: ' + m.from,
    'To: ' + m.to,
    'Subject: ' + m.subject,
    'Date: ' + new Date().toUTCString()
  ];
  if (m.messageId) lines.push('Message-ID: ' + m.messageId);
  if (m.inReplyTo) {
    lines.push('In-Reply-To: ' + m.inReplyTo);
    lines.push('References: ' + m.inReplyTo);
  }
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', m.body, '');
  return lines.join('\r\n');
}

/**
 * Import one raw message. resource holds labelIds and/or threadId. Tries the
 * media-upload form (resource, 'me', blob, options) first, then resource.raw.
 */
function s26_import_(raw, resource, neverMarkSpam) {
  var opts = { neverMarkSpam: !!neverMarkSpam, internalDateSource: 'dateHeader' };
  var attempts = [];
  var copy = function (extra) {
    var r = {};
    Object.keys(resource).forEach(function (k) { r[k] = resource[k]; });
    Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
    return r;
  };
  try {
    var m = Gmail.Users.Messages.import(copy(), 'me', Utilities.newBlob(raw, 'message/rfc822'), opts);
    return { ok: true, method: 'import (media blob)', neverMarkSpam: opts.neverMarkSpam, id: m.id, threadId: m.threadId, labelIds: m.labelIds || [] };
  } catch (e) {
    attempts.push({ method: 'import (media blob)', error: s26_err_(e) });
  }
  try {
    var m2 = Gmail.Users.Messages.import(copy({ raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8) }), 'me', null, opts);
    return { ok: true, method: 'import (resource.raw)', neverMarkSpam: opts.neverMarkSpam, id: m2.id, threadId: m2.threadId, labelIds: m2.labelIds || [], earlierAttempts: attempts };
  } catch (e2) {
    attempts.push({ method: 'import (resource.raw)', error: s26_err_(e2) });
  }
  return { ok: false, attempts: attempts };
}

/** Self-send from the test account to its plus-address; optionally as a reply in threadId. */
function s26_send_(subject, body, threadId, inReplyTo) {
  var r = s26_try_(function () {
    var raw = s26_raw_({
      from: s26_address_(),
      to: s26_plusAddress_(),
      subject: subject,
      inReplyTo: inReplyTo,
      body: body
    });
    var resource = { raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8) };
    if (threadId) resource.threadId = threadId;
    var m = Gmail.Users.Messages.send(resource, 'me');
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [] };
  });
  // Flatten to {ok, id, threadId, labelIds} or {ok: false, error}, like s26_import_.
  if (!r.ok) return r;
  return { ok: true, id: r.value.id, threadId: r.value.threadId, labelIds: r.value.labelIds };
}

function s26_removeLabel_(id) {
  if (typeof Gmail.Users.Labels.remove === 'function') return Gmail.Users.Labels.remove('me', id);
  return Gmail.Users.Labels['delete']('me', id);
}

/** Tracked threads, one Script Property per thread (s26.t.<case>) to stay under the 9 KB value limit. */
function s26_threads_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var out = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('s26.t.') === 0) out[k.slice(6)] = JSON.parse(all[k]);
  });
  return out;
}

function s26_saveThreads_(threads) {
  Object.keys(threads).forEach(function (name) { s26_set_('t.' + name, threads[name]); });
}

function s26_get_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty('s26.' + key);
  if (v === null || v === undefined) return fallback;
  try { return JSON.parse(v); } catch (e) { return v; }
}

function s26_set_(key, value) {
  PropertiesService.getScriptProperties().setProperty('s26.' + key, JSON.stringify(value));
}

/** Run fn; return {ok: true, value} or {ok: false, error}. */
function s26_try_(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: s26_err_(e) };
  }
}

/** e.name, e.message verbatim, and e.details if present. */
function s26_err_(e) {
  var out = {
    name: e && e.name ? String(e.name) : typeof e,
    message: s26_cut_(e && e.message !== undefined ? String(e.message) : String(e))
  };
  if (e && e.details !== undefined) {
    try { out.details = JSON.parse(JSON.stringify(e.details)); } catch (err) { out.details = String(e.details); }
  }
  return out;
}

function s26_cut_(s) {
  return s.length > S26_MAX_TEXT ? s.slice(0, S26_MAX_TEXT) + '…[cut]' : s;
}

/**
 * Replace the test account's address (and any plus-address form of it), and
 * any other address not on example.test, with <test-account>.
 */
function s26_scrub_(text) {
  if (s26_addressCache_) {
    var a = s26_addressCache_;
    var at = a.lastIndexOf('@');
    var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    var re = new RegExp(esc(a.slice(0, at)) + '(\\+[^@\\s"]*)?' + esc(a.slice(at)), 'gi');
    text = text.replace(re, '<test-account>');
  }
  return text.replace(/[A-Za-z0-9._%+-]+@(?!example\.test\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<test-account>');
}

function s26_out_(result) {
  var text = s26_scrub_(JSON.stringify(result));
  console.log(text);
  return JSON.parse(text);
}
