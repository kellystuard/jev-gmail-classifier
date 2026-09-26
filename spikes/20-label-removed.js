/**
 * Spike #20: does removing a user label (standing in for `Jev/Error`) yield
 * `labelRemoved` history records, what shape are they, and how many does one
 * removal produce? Findings: spikes/20-label-removed.md.
 *
 * Runnable functions (all prefixed s20_, all take one optional args object):
 *   s20_setup, s20_start, s20_act, s20_list, s20_state, s20_deleteLabel.
 * Helpers end in `_` so they are private (not runnable, not in the editor's
 * dropdown).
 *
 * Script Properties (all prefixed s20.):
 *   s20.label        {id, name}
 *   s20.start        {historyId, savedAt}
 *   s20.map          {scenario: {threadId, messageIds, ...}}
 *   s20.checkpoints  [{after, historyId, at}]
 *
 * The test account's address is read from getProfile at run time and used
 * only as the To of imported messages. It is never returned or logged: every
 * result goes through s20_out_, which scrubs it to `<test-account>`.
 */

var S20_LABEL_NAME = 'E1-20/Error';
var S20_SCENARIOS = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08'];

// ---------------------------------------------------------------------------
// Runnable functions
// ---------------------------------------------------------------------------

/**
 * Find or create the label, import the S01–S08 threads (S01 has one message,
 * the rest three), and add the label to each with threads.modify. Resets
 * s20.map and s20.checkpoints.
 */
function s20_setup(args) {
  var ctx = s20_ctx_();
  var label = s20_findOrCreateLabel_();
  var map = {};

  S20_SCENARIOS.forEach(function (sc) {
    var count = sc === 'S01' ? 1 : 3;
    var subject = 'E1-20-' + sc + ' label removal';
    var ids = [];
    var threadId = null;
    var lastHeader = null;
    var refs = [];
    for (var i = 0; i < count; i++) {
      var m = s20_import_(ctx, {
        tag: sc + '-' + (i + 1),
        from: ['alice@example.com', 'bob@example.com', 'carol@example.com'][i],
        subject: (i ? 'Re: ' : '') + subject,
        inReplyTo: lastHeader,
        references: refs.length ? refs.join(' ') : null
      }, threadId);
      ids.push(m.id);
      threadId = threadId || m.threadId;
      lastHeader = m.messageIdHeader;
      refs.push(m.messageIdHeader);
      if (m.threadId !== threadId) map[sc + '-threadMismatch'] = true;
    }
    var t = Gmail.Users.Threads.modify({ addLabelIds: [label.id] }, 'me', threadId);
    map[sc] = {
      threadId: threadId,
      messageIds: ids,
      messageCount: ids.length,
      lastMessageIdHeader: lastHeader,
      references: refs.join(' '),
      labelledMessages: (t.messages || []).map(function (m) { return { id: m.id, labelIds: m.labelIds || [] }; })
    };
  });

  var parent = s20_labelByName_('E1-20');
  s20_props_().setProperty('s20.map', JSON.stringify(map));
  s20_props_().setProperty('s20.checkpoints', JSON.stringify([]));
  return s20_out_({
    label: label,
    parentLabelE1_20: parent ? { id: parent.id, type: parent.type } : null,
    map: map,
    historyIdAfter: s20_historyId_()
  }, ctx);
}

/** Save the start position (after s20_setup has applied the labels). */
function s20_start(args) {
  var start = { historyId: Gmail.Users.getProfile('me').historyId, savedAt: new Date().toISOString() };
  s20_props_().setProperty('s20.start', JSON.stringify(start));
  return s20_out_({ start: start }, null);
}

/**
 * The API scenarios S01, S04, S05, S06, S07 in order, with a getProfile
 * historyId checkpoint after each. S08 (deleting the label) is separate:
 * s20_deleteLabel, run after the listings, so the labelId-filtered listing
 * still has a label to filter on.
 *
 * args.only: a list of scenario keys to run (default all five).
 */
function s20_act(args) {
  args = args || {};
  var ctx = s20_ctx_();
  var label = s20_need_('s20.label');
  var map = s20_need_('s20.map');
  var checkpoints = s20_getJson_('s20.checkpoints', []);
  var only = args.only || ['S01', 'S04', 'S05', 'S06', 'S07'];
  var results = {};
  var remove = { removeLabelIds: [label.id] };

  var steps = {
    S01: function () {
      Gmail.Users.Threads.modify(remove, 'me', map.S01.threadId);
      return { method: 'Threads.modify remove' };
    },
    S04: function () {
      Gmail.Users.Threads.modify(remove, 'me', map.S04.threadId);
      return { method: 'Threads.modify remove' };
    },
    S05: function () {
      var id = map.S05.messageIds[0];
      Gmail.Users.Messages.modify(remove, 'me', id);
      return { method: 'Messages.modify remove (first message only)', messageId: id, threadAfter: s20_thread_(map.S05.threadId) };
    },
    S06: function () {
      Gmail.Users.Threads.trash('me', map.S06.threadId);
      var trashed = s20_thread_(map.S06.threadId);
      Gmail.Users.Threads.modify(remove, 'me', map.S06.threadId);
      return { method: 'Threads.trash, then Threads.modify remove', threadAfterTrash: trashed };
    },
    S07: function () {
      var m = s20_import_(ctx, {
        tag: 'S07-4', from: 'dave@example.com', subject: 'Re: E1-20-S07 label removal',
        inReplyTo: map.S07.lastMessageIdHeader, references: map.S07.references
      }, map.S07.threadId);
      map.S07.messageIds.push(m.id);
      map.S07.newMessageId = m.id;
      s20_props_().setProperty('s20.map', JSON.stringify(map));
      var before = s20_thread_(map.S07.threadId);
      Gmail.Users.Threads.modify(remove, 'me', map.S07.threadId);
      return {
        method: 'import reply, then Threads.modify remove',
        newMessageId: m.id,
        newMessageJoinedThread: m.threadId === map.S07.threadId,
        newMessageLabelIdsOnImport: m.labelIds,
        threadBeforeRemoval: before
      };
    }
  };

  only.forEach(function (sc) {
    if (!steps[sc]) throw new Error('Unknown scenario ' + sc + '; s20_act runs S01, S04, S05, S06, S07');
    try {
      results[sc] = steps[sc]();
    } catch (e) {
      results[sc] = { error: s20_err_(e) };
    }
    checkpoints.push({ after: sc, historyId: s20_historyId_(), at: new Date().toISOString() });
    s20_props_().setProperty('s20.checkpoints', JSON.stringify(checkpoints));
  });

  return s20_out_({ results: results, checkpoints: checkpoints }, ctx);
}

/**
 * S08: delete the label while it is still on the S08 thread. Run after the
 * first set of listings, then list again.
 */
function s20_deleteLabel(args) {
  var label = s20_need_('s20.label');
  var map = s20_need_('s20.map');
  var checkpoints = s20_getJson_('s20.checkpoints', []);
  var before = s20_thread_(map.S08.threadId);
  var name = typeof Gmail.Users.Labels.remove === 'function' ? 'remove' : 'delete';
  var error = null;
  try {
    Gmail.Users.Labels[name]('me', label.id);
  } catch (e) {
    error = s20_err_(e);
  }
  var after = s20_thread_(map.S08.threadId);
  checkpoints.push({ after: 'S08', historyId: s20_historyId_(), at: new Date().toISOString() });
  s20_props_().setProperty('s20.checkpoints', JSON.stringify(checkpoints));
  return s20_out_({
    method: 'Labels.' + name,
    labelId: label.id,
    error: error,
    threadBefore: before,
    threadAfter: after,
    labelStillListed: !!s20_labelByName_(S20_LABEL_NAME),
    checkpoints: checkpoints
  }, null);
}

/**
 * Page History.list from s20.start.
 *
 * args.historyTypes: default ['labelRemoved'].
 * args.labelId: a label ID to filter on; or args.labelFilter: true to use
 *   the saved E1-20/Error label ID.
 * args.startHistoryId: overrides s20.start.
 */
function s20_list(args) {
  args = args || {};
  var start = s20_getJson_('s20.start', null);
  var startHistoryId = args.startHistoryId || (start && start.historyId);
  if (!startHistoryId) throw new Error('No start position; run s20_start first');
  var map = s20_getJson_('s20.map', {});
  var label = s20_getJson_('s20.label', null);
  var historyTypes = args.historyTypes || ['labelRemoved'];
  var labelId = args.labelId || (args.labelFilter && label ? label.id : null);
  var tagOf = s20_tagIndex_(map);

  var records = [];
  var pages = 0;
  var pageToken = null;
  var responseHistoryId = null;
  var error = null;
  try {
    do {
      var opts = { startHistoryId: String(startHistoryId), historyTypes: historyTypes };
      if (labelId) opts.labelId = labelId;
      if (pageToken) opts.pageToken = pageToken;
      var resp = Gmail.Users.History.list('me', opts);
      pages++;
      responseHistoryId = resp.historyId;
      (resp.history || []).forEach(function (h) {
        var rec = { id: h.id, keys: Object.keys(h).sort() };
        if (h.labelsRemoved) {
          rec.labelsRemoved = h.labelsRemoved.map(function (a) {
            var m = a.message || {};
            return {
              entryKeys: Object.keys(a).sort(),
              labelIds: a.labelIds || [],
              message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], keys: Object.keys(m).sort() },
              scenario: tagOf(m)
            };
          });
        }
        if (h.messagesAdded) {
          rec.messagesAdded = h.messagesAdded.map(function (a) {
            var m = a.message || {};
            return { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], scenario: tagOf(m) };
          });
        }
        if (h.messages) rec.messageIds = h.messages.map(function (m) { return m.id; });
        records.push(rec);
      });
      pageToken = resp.nextPageToken;
    } while (pageToken);
  } catch (e) {
    error = s20_err_(e);
  }

  // Per scenario: how many records and entries, and which messages they cover.
  var byScenario = {};
  records.forEach(function (r) {
    var seenInRecord = {};
    (r.labelsRemoved || []).forEach(function (e) {
      var sc = (e.scenario || 'untagged').split(':')[0];
      var s = byScenario[sc] = byScenario[sc] || { records: 0, entries: 0, messageIds: [] };
      s.entries++;
      if (!seenInRecord[sc]) { s.records++; seenInRecord[sc] = true; }
      if (s.messageIds.indexOf(e.message.id) < 0) s.messageIds.push(e.message.id);
    });
  });
  Object.keys(byScenario).forEach(function (sc) {
    var ids = (map[sc] && map[sc].messageIds) || [];
    byScenario[sc].threadMessageCount = ids.length;
    byScenario[sc].coversAllMessages = ids.length > 0 && ids.every(function (id) { return byScenario[sc].messageIds.indexOf(id) >= 0; });
  });

  return s20_out_({
    historyTypes: historyTypes,
    labelId: labelId,
    startHistoryId: String(startHistoryId),
    pages: pages,
    responseHistoryId: responseHistoryId,
    recordCount: records.length,
    error: error,
    byScenario: byScenario,
    listedAt: new Date().toISOString(),
    records: records
  }, null);
}

/** Each scenario thread's messages and their current labelIds. */
function s20_state(args) {
  var map = s20_need_('s20.map');
  var label = s20_getJson_('s20.label', null);
  var threads = {};
  S20_SCENARIOS.forEach(function (sc) {
    if (map[sc]) threads[sc] = s20_thread_(map[sc].threadId);
  });
  return s20_out_({ labelId: label && label.id, threads: threads }, null);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function s20_findOrCreateLabel_() {
  var existing = s20_labelByName_(S20_LABEL_NAME);
  var created = false;
  var l = existing;
  if (!l) {
    l = Gmail.Users.Labels.create({
      name: S20_LABEL_NAME,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    }, 'me');
    created = true;
  }
  var label = { id: l.id, name: l.name, type: l.type, created: created };
  s20_props_().setProperty('s20.label', JSON.stringify(label));
  return label;
}

function s20_labelByName_(name) {
  var labels = Gmail.Users.Labels.list('me').labels || [];
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].name === name) return labels[i];
  }
  return null;
}

function s20_thread_(threadId) {
  try {
    var t = Gmail.Users.Threads.get('me', threadId, { format: 'minimal' });
    return {
      threadId: threadId,
      messages: (t.messages || []).map(function (m) { return { id: m.id, labelIds: m.labelIds || [] }; })
    };
  } catch (e) {
    return { threadId: threadId, error: s20_err_(e) };
  }
}

function s20_tagIndex_(map) {
  var byMsg = {};
  var byThread = {};
  S20_SCENARIOS.forEach(function (sc) {
    var e = map[sc];
    if (!e) return;
    byThread[e.threadId] = sc;
    e.messageIds.forEach(function (id, i) { byMsg[id] = sc + ':msg' + (i + 1); });
  });
  return function (m) {
    if (byMsg[m.id]) return byMsg[m.id];
    if (byThread[m.threadId]) return byThread[m.threadId] + ':thread';
    return null;
  };
}

function s20_ctx_() {
  return { address: Gmail.Users.getProfile('me').emailAddress };
}

/** Messages.import(resource, userId, mediaData, optionalArgs), neverMarkSpam. */
function s20_import_(ctx, o, threadId) {
  var messageIdHeader = '<e1-20-' + o.tag.toLowerCase() + '-' + Date.now() + '-' +
    Math.floor(Math.random() * 1e6) + '@example.com>';
  var lines = [
    'From: ' + o.from,
    'To: ' + ctx.address,
    'Subject: ' + o.subject,
    'Date: ' + Utilities.formatDate(new Date(), 'Etc/UTC', 'EEE, dd MMM yyyy HH:mm:ss Z'),
    'Message-ID: ' + messageIdHeader
  ];
  if (o.inReplyTo) lines.push('In-Reply-To: ' + o.inReplyTo);
  if (o.references) lines.push('References: ' + o.references);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '',
    'Synthetic test message for spike #20 (' + o.tag + ').\r\n');
  var resource = { labelIds: ['INBOX', 'UNREAD'] };
  if (threadId) resource.threadId = threadId;
  var blob = Utilities.newBlob(lines.join('\r\n'), 'message/rfc822');
  var m = Gmail.Users.Messages['import'](resource, 'me', blob, { neverMarkSpam: true });
  return { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], messageIdHeader: messageIdHeader };
}

function s20_props_() {
  return PropertiesService.getScriptProperties();
}

function s20_getJson_(key, fallback) {
  var v = s20_props_().getProperty(key);
  return v ? JSON.parse(v) : fallback;
}

function s20_need_(key) {
  var v = s20_getJson_(key, null);
  if (!v) throw new Error(key + ' is not set; run s20_setup first');
  return v;
}

function s20_historyId_() {
  return Gmail.Users.getProfile('me').historyId;
}

function s20_err_(e) {
  return { name: e && e.name, message: String(e && e.message), code: e && e.details && e.details.code };
}

/** Serialize, scrub the test account's address, log, and return. */
function s20_out_(result, ctx) {
  var json = JSON.stringify(result);
  var address = ctx ? ctx.address : Gmail.Users.getProfile('me').emailAddress;
  var at = address.lastIndexOf('@');
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var re = new RegExp(esc(address.slice(0, at)) + '(\\+[^@\\s"<>]*)?@' + esc(address.slice(at + 1)), 'gi');
  json = json.replace(re, function (_, plus) { return '<test-account>' + (plus || ''); });
  console.log(json);
  return JSON.parse(json);
}
