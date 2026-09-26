/**
 * Spike #19: which `messageAdded` history records appear for each kind of
 * mail, what they contain, and what a message's `historyId` and
 * `internalDate` mean. Findings: spikes/19-message-added.md.
 *
 * Runnable functions (all prefixed s19_, all take one optional args object):
 *   s19_prepare, s19_start, s19_act, s19_listAdded, s19_listAll,
 *   s19_afterList, s19_details, s19_modifyOne, s19_cleanup.
 * Helpers end in `_` so they are private (not runnable, not in the editor's
 * dropdown).
 *
 * Script Properties (all prefixed s19.):
 *   s19.start        {historyId, savedAt}
 *   s19.map          {scenario: {messageIds, threadId, method, ...}}
 *   s19.checkpoints  [{after, historyId, at}]
 *
 * The test account's address is read from getProfile at run time and used
 * only to address messages. It is never returned or logged: every result is
 * passed through s19_out_, which scrubs it (and any plus-address form) to
 * `<test-account>`.
 */

var S19_PREFIX = 'E1-19-';

// ---------------------------------------------------------------------------
// Runnable functions
// ---------------------------------------------------------------------------

/**
 * Before the start position: import the S02 "before" thread (2 messages) and
 * the S08c seed message (for the optional "block sender" case). Resets
 * s19.map and s19.checkpoints.
 */
function s19_prepare(args) {
  args = args || {};
  var ctx = s19_ctx_();
  var map = {};

  var first = s19_import_(ctx, {
    tag: 'S02-before-1',
    from: 'alice@example.com',
    subject: S19_PREFIX + 'S02 before-thread'
  }, {});
  var second = s19_import_(ctx, {
    tag: 'S02-before-2',
    from: 'bob@example.com',
    subject: 'Re: ' + S19_PREFIX + 'S02 before-thread',
    inReplyTo: first.messageIdHeader,
    references: first.messageIdHeader
  }, { threadId: first.threadId });
  map['S02-before'] = {
    messageIds: [first.id, second.id],
    threadId: first.threadId,
    method: 'import',
    lastMessageIdHeader: second.messageIdHeader,
    importedLabelIds: [first.labelIds, second.labelIds],
    sameThread: first.threadId === second.threadId
  };

  var seed = s19_import_(ctx, {
    tag: 'S08c-seed',
    from: 'blocked-sender@example.net',
    subject: S19_PREFIX + 'S08c seed (block this sender)'
  }, {});
  map['S08c-seed'] = {
    messageIds: [seed.id],
    threadId: seed.threadId,
    method: 'import',
    from: 'blocked-sender@example.net',
    importedLabelIds: [seed.labelIds]
  };

  s19_props_().setProperty('s19.map', JSON.stringify(map));
  s19_props_().setProperty('s19.checkpoints', JSON.stringify([]));
  return s19_out_({ map: map, historyIdAfter: s19_historyId_() }, ctx);
}

/** Save the start position: getProfile's historyId and the time. */
function s19_start(args) {
  var profile = Gmail.Users.getProfile('me');
  var start = { historyId: profile.historyId, savedAt: new Date().toISOString() };
  s19_props_().setProperty('s19.start', JSON.stringify(start));
  return s19_out_({ start: start }, null);
}

/**
 * Create the API scenarios in order, saving IDs to s19.map and returning a
 * getProfile historyId checkpoint after each.
 *
 * args.from / args.to: run only the scenarios in that (inclusive) range of
 *   the order below, for example {from: 'S08c', to: 'S08c'}.
 * args.skip: scenario keys to skip, for example ['S08c'].
 */
function s19_act(args) {
  args = args || {};
  var ctx = s19_ctx_();
  var map = s19_getJson_('s19.map', {});
  var checkpoints = s19_getJson_('s19.checkpoints', []);
  var steps = s19_scenarios_();
  var keys = steps.map(function (s) { return s.key; });
  var fromIdx = args.from ? keys.indexOf(args.from) : 0;
  var toIdx = args.to ? keys.indexOf(args.to) : keys.length - 1;
  if (fromIdx < 0 || toIdx < 0) {
    throw new Error('Unknown scenario in from/to. Known: ' + keys.join(', '));
  }
  var skip = args.skip || [];
  var ran = [];
  var errors = {};
  var started = Date.now();

  for (var i = fromIdx; i <= toIdx; i++) {
    var step = steps[i];
    if (skip.indexOf(step.key) >= 0) continue;
    if (Date.now() - started > 4.5 * 60 * 1000) {
      errors[step.key] = 'Not run: time budget reached; rerun with {from: "' + step.key + '"}';
      break;
    }
    try {
      map[step.key] = step.run(ctx, map);
      ran.push(step.key);
    } catch (e) {
      errors[step.key] = s19_err_(e);
    }
    // Save as we go, so a later failure doesn't lose earlier IDs.
    s19_props_().setProperty('s19.map', JSON.stringify(map));
    checkpoints.push({ after: step.key, historyId: s19_historyId_(), at: new Date().toISOString() });
    s19_props_().setProperty('s19.checkpoints', JSON.stringify(checkpoints));
  }

  return s19_out_({
    ran: ran,
    errors: errors,
    map: map,
    checkpoints: checkpoints,
    elapsedMs: Date.now() - started
  }, ctx);
}

/** Page history.list with historyTypes ['messageAdded']. */
function s19_listAdded(args) {
  return s19_list_(['messageAdded'], args || {});
}

/** Page history.list with every history type. */
function s19_listAll(args) {
  return s19_list_(['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'], args || {});
}

/** Trash the S11 message (the "trashed after being listed once" case). */
function s19_afterList(args) {
  var map = s19_getJson_('s19.map', {});
  var s11 = map.S11;
  if (!s11) throw new Error('S11 not in s19.map; run s19_act first');
  var trashed = Gmail.Users.Messages.trash('me', s11.messageIds[0]);
  return s19_out_({
    trashed: s11.messageIds[0],
    labelIdsReturned: trashed.labelIds || null,
    historyIdAfter: s19_historyId_(),
    at: new Date().toISOString()
  }, null);
}

/**
 * For each message in s19.map: current labelIds, historyId, internalDate,
 * Subject and Date. Also every message now in each scenario's thread
 * (threads.get minimal), which catches copies Gmail made (for example the
 * inbox copy of a self-send, if it has its own ID).
 */
function s19_details(args) {
  var map = s19_getJson_('s19.map', {});
  var start = s19_getJson_('s19.start', null);
  var messages = [];
  var threads = [];
  var seenThreads = {};

  Object.keys(map).forEach(function (scenario) {
    var entry = map[scenario];
    (entry.messageIds || []).forEach(function (id) {
      messages.push(s19_detail_(scenario, id));
    });
    if (entry.threadId && !seenThreads[entry.threadId]) {
      seenThreads[entry.threadId] = true;
      try {
        var t = Gmail.Users.Threads.get('me', entry.threadId, { format: 'minimal' });
        threads.push({
          scenario: scenario,
          threadId: entry.threadId,
          threadHistoryId: t.historyId,
          messages: (t.messages || []).map(function (m) {
            return {
              id: m.id,
              labelIds: m.labelIds || [],
              historyId: m.historyId,
              internalDate: Number(m.internalDate),
              internalDateIso: new Date(Number(m.internalDate)).toISOString()
            };
          })
        });
      } catch (e) {
        threads.push({ scenario: scenario, threadId: entry.threadId, error: s19_err_(e) });
      }
    }
  });

  return s19_out_({ start: start, messages: messages, threads: threads }, null);
}

/**
 * Finding 6: does a pre-position message's historyId move when the message
 * is later modified? Marks the oldest S02-before message read.
 */
function s19_modifyOne(args) {
  var map = s19_getJson_('s19.map', {});
  var start = s19_getJson_('s19.start', null);
  var before = map['S02-before'];
  if (!before) throw new Error('S02-before not in s19.map; run s19_prepare first');
  var id = before.messageIds[0];
  var m1 = Gmail.Users.Messages.get('me', id, { format: 'minimal' });
  Gmail.Users.Messages.modify({ removeLabelIds: ['UNREAD'] }, 'me', id);
  var m2 = Gmail.Users.Messages.get('me', id, { format: 'minimal' });
  return s19_out_({
    messageId: id,
    startHistoryId: start && start.historyId,
    historyIdBefore: m1.historyId,
    labelIdsBefore: m1.labelIds || [],
    historyIdAfter: m2.historyId,
    labelIdsAfter: m2.labelIds || [],
    internalDateBefore: m1.internalDate,
    internalDateAfter: m2.internalDate,
    movedPastStart: start ? s19_gt_(m2.historyId, start.historyId) : null,
    profileHistoryId: s19_historyId_()
  }, null);
}

/** After recording: take S09 out of Spam and back to the inbox. */
function s19_cleanup(args) {
  var map = s19_getJson_('s19.map', {});
  var done = {};
  if (map.S09) {
    try {
      var m = Gmail.Users.Messages.modify({ addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] }, 'me', map.S09.messageIds[0]);
      done.S09 = m.labelIds || [];
    } catch (e) {
      done.S09 = s19_err_(e);
    }
  }
  return s19_out_({ done: done }, null);
}

// ---------------------------------------------------------------------------
// Scenarios, in the order s19_act runs them
// ---------------------------------------------------------------------------

function s19_scenarios_() {
  return [
    { key: 'S01', run: function (ctx) {
      var m = s19_import_(ctx, { tag: 'S01', from: 'alice@example.com', subject: S19_PREFIX + 'S01 received new thread' }, {});
      return s19_entry_([m], 'import', { messageIdHeader: m.messageIdHeader });
    } },
    { key: 'S02', run: function (ctx, map) {
      var b = s19_need_(map, 'S02-before');
      var m = s19_import_(ctx, {
        tag: 'S02', from: 'carol@example.com', subject: 'Re: ' + S19_PREFIX + 'S02 before-thread',
        inReplyTo: b.lastMessageIdHeader, references: b.lastMessageIdHeader
      }, { threadId: b.threadId });
      return s19_entry_([m], 'import', { joinedThread: m.threadId === b.threadId });
    } },
    { key: 'S03', run: function (ctx, map) {
      var s01 = s19_need_(map, 'S01');
      var m = s19_import_(ctx, {
        tag: 'S03', from: 'bob@example.com', subject: 'Re: ' + S19_PREFIX + 'S01 received new thread',
        inReplyTo: s01.messageIdHeader, references: s01.messageIdHeader
      }, { threadId: s01.threadId });
      return s19_entry_([m], 'import', { joinedThread: m.threadId === s01.threadId });
    } },
    { key: 'S04a', run: function (ctx) {
      var m = s19_send_(ctx, { tag: 'S04a', to: s19_plus_(ctx, 's04'), subject: S19_PREFIX + 'S04a sent new thread' }, null);
      return s19_entry_([m], 'send', { to: '<test-account>+s04' });
    } },
    { key: 'S04b', run: function (ctx) {
      var m = s19_insert_(ctx, {
        tag: 'S04b', from: ctx.address, to: 'dave@example.com', subject: S19_PREFIX + 'S04b inserted SENT'
      }, { labelIds: ['SENT'] }, {});
      return s19_entry_([m], 'insert', { requestedLabelIds: ['SENT'] });
    } },
    { key: 'S05', run: function (ctx, map) {
      var s01 = s19_need_(map, 'S01');
      var m = s19_send_(ctx, {
        tag: 'S05', to: s19_plus_(ctx, 's05'), subject: 'Re: ' + S19_PREFIX + 'S01 received new thread',
        inReplyTo: s01.messageIdHeader, references: s01.messageIdHeader
      }, s01.threadId);
      return s19_entry_([m], 'send', { to: '<test-account>+s05', joinedThread: m.threadId === s01.threadId });
    } },
    { key: 'S06', run: function (ctx) {
      var m = s19_send_(ctx, { tag: 'S06', to: ctx.address, subject: S19_PREFIX + 'S06 sent to self' }, null);
      return s19_entry_([m], 'send', { to: '<test-account>' });
    } },
    { key: 'S07', run: function (ctx) { return s19_drafts_(ctx); } },
    { key: 'S08a', run: function (ctx) {
      var m = s19_insert_(ctx, {
        tag: 'S08a', from: 'eve@example.com', subject: S19_PREFIX + 'S08a inserted SPAM'
      }, { labelIds: ['SPAM'] }, {});
      return s19_entry_([m], 'insert', { requestedLabelIds: ['SPAM'] });
    } },
    { key: 'S08b', run: function (ctx) {
      // Obvious spam traits, no neverMarkSpam. Optional: record, don't rely on it.
      var m = s19_import_(ctx, {
        tag: 'S08b', from: 'winner@prize-lottery.example', subject: S19_PREFIX + 'S08b CONGRATULATIONS!!! You WON $1,000,000 - CLAIM NOW',
        body: 'Dear winner,\r\n\r\nYou have been selected to receive $1,000,000 USD. ' +
          'Send your bank account number and a processing fee of $99 to claim your prize TODAY. ' +
          'Act now, this offer expires in 24 hours!!!\r\n\r\nClick here: http://prize-lottery.example/claim\r\n'
      }, {}, { neverMarkSpam: false });
      return s19_entry_([m], 'import', { neverMarkSpam: false });
    } },
    { key: 'S08c', run: function (ctx) {
      // Optional: the maintainer has blocked blocked-sender@example.net (the
      // S08c seed's From). No neverMarkSpam, so a block filter can act.
      var m = s19_import_(ctx, {
        tag: 'S08c', from: 'blocked-sender@example.net', subject: S19_PREFIX + 'S08c from blocked sender'
      }, {}, { neverMarkSpam: false });
      return s19_entry_([m], 'import', { from: 'blocked-sender@example.net', neverMarkSpam: false });
    } },
    { key: 'S09', run: function (ctx) {
      var m = s19_import_(ctx, { tag: 'S09', from: 'frank@example.com', subject: S19_PREFIX + 'S09 moved to Spam' }, {});
      var after = Gmail.Users.Messages.modify({ addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }, 'me', m.id);
      return s19_entry_([m], 'import', { labelIdsAfterModify: after.labelIds || [] });
    } },
    { key: 'S10', run: function (ctx) {
      var m = s19_import_(ctx, { tag: 'S10', from: 'grace@example.com', subject: S19_PREFIX + 'S10 trashed before listing' }, {});
      var after = Gmail.Users.Messages.trash('me', m.id);
      return s19_entry_([m], 'import', { labelIdsAfterTrash: after.labelIds || [] });
    } },
    { key: 'S11', run: function (ctx) {
      var m = s19_import_(ctx, { tag: 'S11', from: 'heidi@example.com', subject: S19_PREFIX + 'S11 trashed after first listing' }, {});
      return s19_entry_([m], 'import', {});
    } },
    { key: 'S12b', run: function (ctx) {
      var m = s19_insert_(ctx, {
        tag: 'S12b', from: 'deals@shop.example', subject: S19_PREFIX + 'S12b inserted Promotions'
      }, { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }, {});
      return s19_entry_([m], 'insert', { requestedLabelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] });
    } },
    { key: 'S12c', run: function (ctx) { return s19_filterCase_(ctx, 'S12c', 'categorize as Promotions'); } },
    { key: 'S13', run: function (ctx) { return s19_filterCase_(ctx, 'S13', 'skip the Inbox'); } },
    { key: 'S14', run: function (ctx) { return s19_filterCase_(ctx, 'S14', 'apply label E1-19-filtered'); } },
    { key: 'S15', run: function (ctx) {
      // Optional: the maintainer deletes this one forever in the UI before listing.
      var m = s19_import_(ctx, { tag: 'S15', from: 'ivan@example.com', subject: S19_PREFIX + 'S15 delete forever' }, {});
      return s19_entry_([m], 'import', {});
    } },
    // Finding 7: which internalDateSource each method uses by default. The
    // Date header is set 3 hours in the past, so internalDate shows whether
    // it came from the header or the receive time.
    { key: 'D1', run: function (ctx) {
      var m = s19_import_(ctx, { tag: 'D1', from: 'judy@example.com', subject: S19_PREFIX + 'D1 import default date source', dateOffsetMs: -3 * 3600 * 1000 }, {});
      return s19_entry_([m], 'import', { dateHeaderOffsetHours: -3, internalDateSource: '(default)' });
    } },
    { key: 'D2', run: function (ctx) {
      var m = s19_import_(ctx, { tag: 'D2', from: 'judy@example.com', subject: S19_PREFIX + 'D2 import receivedTime', dateOffsetMs: -3 * 3600 * 1000 }, {}, { internalDateSource: 'receivedTime' });
      return s19_entry_([m], 'import', { dateHeaderOffsetHours: -3, internalDateSource: 'receivedTime' });
    } },
    { key: 'D3', run: function (ctx) {
      var m = s19_insert_(ctx, { tag: 'D3', from: 'judy@example.com', subject: S19_PREFIX + 'D3 insert default date source', dateOffsetMs: -3 * 3600 * 1000 }, { labelIds: ['INBOX', 'UNREAD'] }, {});
      return s19_entry_([m], 'insert', { dateHeaderOffsetHours: -3, internalDateSource: '(default)' });
    } }
  ];
}

/** S07: draft lifecycle (create, update twice, send), plus a deleted draft. */
function s19_drafts_(ctx) {
  var steps = [];
  var subject = S19_PREFIX + 'S07 draft lifecycle';
  var to = s19_plus_(ctx, 's07');

  var d = Gmail.Users.Drafts.create({ message: { raw: s19_b64_(s19_raw_(ctx, { tag: 'S07-v1', to: to, subject: subject, body: 'Draft v1\r\n' }).raw) } }, 'me');
  steps.push(s19_draftStep_('create', d));
  var draftId = d.id;

  for (var v = 2; v <= 3; v++) {
    d = Gmail.Users.Drafts.update({ id: draftId, message: { raw: s19_b64_(s19_raw_(ctx, { tag: 'S07-v' + v, to: to, subject: subject, body: 'Draft v' + v + '\r\n' }).raw) } }, 'me', draftId);
    steps.push(s19_draftStep_('update' + (v - 1), d));
  }

  var sent = Gmail.Users.Drafts.send({ id: draftId }, 'me');
  steps.push({ step: 'send', messageId: sent.id, threadId: sent.threadId, labelIds: sent.labelIds || [] });

  // Second draft, deleted. The Advanced Service names drafts.delete `remove`.
  var d2 = Gmail.Users.Drafts.create({ message: { raw: s19_b64_(s19_raw_(ctx, { tag: 'S07b', to: to, subject: S19_PREFIX + 'S07b draft deleted', body: 'Deleted draft\r\n' }).raw) } }, 'me');
  steps.push(s19_draftStep_('create-b', d2));
  var removeName = typeof Gmail.Users.Drafts.remove === 'function' ? 'remove' : 'delete';
  Gmail.Users.Drafts[removeName]('me', d2.id);
  steps.push({ step: 'delete-b', method: 'Drafts.' + removeName, draftId: d2.id });

  var ids = [];
  steps.forEach(function (s) { if (s.messageId && ids.indexOf(s.messageId) < 0) ids.push(s.messageId); });
  return {
    messageIds: ids,
    threadId: sent.threadId,
    threadIdB: d2.message && d2.message.threadId,
    method: 'drafts',
    to: '<test-account>+s07',
    draftId: draftId,
    steps: steps
  };
}

function s19_draftStep_(step, d) {
  return {
    step: step,
    draftId: d.id,
    messageId: d.message && d.message.id,
    threadId: d.message && d.message.threadId,
    labelIds: (d.message && d.message.labelIds) || []
  };
}

/**
 * S12c, S13, S14: one imported copy and one self-sent copy, for the
 * maintainer's filter on "Subject contains E1-19-<key>". S12c's filter uses
 * `E1-19-S12c`, not `E1-19-S12`, so it can't also catch S12b's subject.
 */
function s19_filterCase_(ctx, sNN, filterAction) {
  var subject = S19_PREFIX + sNN + ' filter: ' + filterAction;
  var imported = s19_import_(ctx, { tag: sNN + '-import', from: 'kim@example.com', subject: subject }, {});
  var sent = s19_send_(ctx, { tag: sNN + '-send', to: s19_plus_(ctx, sNN.toLowerCase()), subject: subject }, null);
  return {
    messageIds: [imported.id, sent.id],
    threadId: imported.threadId,
    threadIds: [imported.threadId, sent.threadId],
    method: 'import + send',
    copies: {
      import: { id: imported.id, threadId: imported.threadId, labelIdsReturned: imported.labelIds },
      send: { id: sent.id, threadId: sent.threadId, labelIdsReturned: sent.labelIds, to: '<test-account>+' + sNN.toLowerCase() }
    }
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

function s19_list_(historyTypes, args) {
  var start = s19_getJson_('s19.start', null);
  var startHistoryId = args.startHistoryId || (start && start.historyId);
  if (!startHistoryId) throw new Error('No start position; run s19_start first');
  var map = s19_getJson_('s19.map', {});
  var tagOf = s19_tagIndex_(map);
  var maxResults = args.maxResults || 5;

  var records = [];
  var pages = 0;
  var pageToken = null;
  var responseHistoryIds = [];
  var addedCount = {};
  do {
    var opts = { startHistoryId: String(startHistoryId), historyTypes: historyTypes, maxResults: maxResults };
    if (pageToken) opts.pageToken = pageToken;
    var resp = Gmail.Users.History.list('me', opts);
    pages++;
    responseHistoryIds.push(resp.historyId);
    (resp.history || []).forEach(function (h) {
      var rec = { id: h.id, keys: Object.keys(h).sort() };
      if (h.messagesAdded) {
        rec.messagesAdded = h.messagesAdded.map(function (a) {
          var m = a.message || {};
          addedCount[m.id] = (addedCount[m.id] || 0) + 1;
          return { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], keys: Object.keys(m).sort(), entryKeys: Object.keys(a).sort(), scenario: tagOf(m) };
        });
      }
      ['messagesDeleted', 'labelsAdded', 'labelsRemoved'].forEach(function (k) {
        if (!h[k]) return;
        rec[k] = h[k].map(function (a) {
          var m = a.message || {};
          var o = { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], scenario: tagOf(m) };
          if (a.labelIds) o.changedLabelIds = a.labelIds;
          return o;
        });
      });
      if (h.messages) {
        var addedIds = (h.messagesAdded || []).map(function (a) { return a.message && a.message.id; }).sort();
        var msgIds = h.messages.map(function (m) { return m.id; }).sort();
        rec.messages = {
          ids: msgIds,
          keys: h.messages.length ? Object.keys(h.messages[0]).sort() : [],
          sameIdsAsMessagesAdded: JSON.stringify(addedIds) === JSON.stringify(msgIds)
        };
      }
      records.push(rec);
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);

  var recordIds = records.map(function (r) { return r.id; });
  var dupRecordIds = recordIds.filter(function (id, i) { return recordIds.indexOf(id) !== i; });
  var multiAdded = Object.keys(addedCount).filter(function (id) { return addedCount[id] > 1; });

  return s19_out_({
    historyTypes: historyTypes,
    startHistoryId: String(startHistoryId),
    maxResults: maxResults,
    pages: pages,
    responseHistoryIds: responseHistoryIds,
    recordCount: records.length,
    duplicateRecordIds: dupRecordIds,
    messagesInMoreThanOneAddedRecord: multiAdded,
    listedAt: new Date().toISOString(),
    records: records
  }, null);
}

/** Returns a function mapping a history message to its scenario key. */
function s19_tagIndex_(map) {
  var byMsg = {};
  var byThread = {};
  Object.keys(map).forEach(function (k) {
    var e = map[k];
    (e.messageIds || []).forEach(function (id) { byMsg[id] = k; });
    (e.steps || []).forEach(function (s) { if (s.messageId) byMsg[s.messageId] = k + ':' + s.step; });
    [e.threadId, e.threadIdB].concat(e.threadIds || []).forEach(function (t) { if (t && !byThread[t]) byThread[t] = k; });
  });
  return function (m) {
    if (byMsg[m.id]) return byMsg[m.id];
    if (byThread[m.threadId]) return byThread[m.threadId] + ' (thread)';
    return null;
  };
}

// ---------------------------------------------------------------------------
// Message creation helpers
// ---------------------------------------------------------------------------

function s19_ctx_() {
  var address = Gmail.Users.getProfile('me').emailAddress;
  var at = address.lastIndexOf('@');
  return { address: address, local: address.slice(0, at), domain: address.slice(at + 1) };
}

function s19_plus_(ctx, tag) {
  return ctx.local + '+' + tag + '@' + ctx.domain;
}

/**
 * Build an RFC 2822 message. o: {tag, from?, to?, subject, body?,
 * inReplyTo?, references?, dateOffsetMs?}. `to` defaults to the test
 * account. Returns {raw, messageIdHeader}.
 */
function s19_raw_(ctx, o) {
  var date = new Date(Date.now() + (o.dateOffsetMs || 0));
  var messageIdHeader = '<e1-19-' + String(o.tag).toLowerCase() + '-' + Date.now() + '-' +
    Math.floor(Math.random() * 1e6) + '@example.com>';
  var lines = [];
  if (o.from) lines.push('From: ' + o.from);
  lines.push('To: ' + (o.to || ctx.address));
  lines.push('Subject: ' + o.subject);
  lines.push('Date: ' + Utilities.formatDate(date, 'Etc/UTC', 'EEE, dd MMM yyyy HH:mm:ss Z'));
  lines.push('Message-ID: ' + messageIdHeader);
  if (o.inReplyTo) lines.push('In-Reply-To: ' + o.inReplyTo);
  if (o.references) lines.push('References: ' + o.references);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('');
  lines.push(o.body || ('Synthetic test message for spike #19 (' + o.tag + ').\r\n'));
  return { raw: lines.join('\r\n'), messageIdHeader: messageIdHeader };
}

function s19_b64_(raw) {
  return Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8);
}

/**
 * Messages.import(resource, userId, mediaData, optionalArgs). Resource
 * defaults to labelIds INBOX + UNREAD; neverMarkSpam defaults to true.
 */
function s19_import_(ctx, o, resourceExtra, optionalArgs) {
  var built = s19_raw_(ctx, o);
  var resource = { labelIds: ['INBOX', 'UNREAD'] };
  Object.keys(resourceExtra || {}).forEach(function (k) { resource[k] = resourceExtra[k]; });
  var opts = { neverMarkSpam: true };
  Object.keys(optionalArgs || {}).forEach(function (k) { opts[k] = optionalArgs[k]; });
  var blob = Utilities.newBlob(built.raw, 'message/rfc822');
  var m = Gmail.Users.Messages['import'](resource, 'me', blob, opts);
  return { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], messageIdHeader: built.messageIdHeader };
}

/** Messages.insert(resource, userId, mediaData, optionalArgs): exact labels, no scanning. */
function s19_insert_(ctx, o, resource, optionalArgs) {
  var built = s19_raw_(ctx, o);
  var blob = Utilities.newBlob(built.raw, 'message/rfc822');
  var m = Gmail.Users.Messages.insert(resource, 'me', blob, optionalArgs || {});
  return { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], messageIdHeader: built.messageIdHeader };
}

/** Messages.send({raw, threadId?}, userId). From is filled in by Gmail. */
function s19_send_(ctx, o, threadId) {
  var built = s19_raw_(ctx, o);
  var resource = { raw: s19_b64_(built.raw) };
  if (threadId) resource.threadId = threadId;
  var m = Gmail.Users.Messages.send(resource, 'me');
  return { id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], messageIdHeader: built.messageIdHeader };
}

function s19_entry_(msgs, method, extra) {
  var e = {
    messageIds: msgs.map(function (m) { return m.id; }),
    threadId: msgs[0].threadId,
    method: method,
    labelIdsReturned: msgs.map(function (m) { return m.labelIds; })
  };
  Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
  return e;
}

function s19_detail_(scenario, id) {
  try {
    var m = Gmail.Users.Messages.get('me', id, { format: 'metadata', metadataHeaders: ['Subject', 'Date'] });
    var headers = {};
    ((m.payload && m.payload.headers) || []).forEach(function (h) { headers[h.name] = h.value; });
    var internal = Number(m.internalDate);
    var dateHeaderMs = headers.Date ? Date.parse(headers.Date) : null;
    return {
      scenario: scenario,
      id: id,
      threadId: m.threadId,
      labelIds: m.labelIds || [],
      historyId: m.historyId,
      internalDate: internal,
      internalDateIso: new Date(internal).toISOString(),
      subject: headers.Subject || null,
      dateHeader: headers.Date || null,
      internalMinusDateHeaderMs: dateHeaderMs === null || isNaN(dateHeaderMs) ? null : internal - dateHeaderMs
    };
  } catch (e) {
    return { scenario: scenario, id: id, error: s19_err_(e) };
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function s19_props_() {
  return PropertiesService.getScriptProperties();
}

function s19_getJson_(key, fallback) {
  var v = s19_props_().getProperty(key);
  return v ? JSON.parse(v) : fallback;
}

function s19_need_(map, key) {
  if (!map[key]) throw new Error(key + ' is not in s19.map yet');
  return map[key];
}

function s19_historyId_() {
  return Gmail.Users.getProfile('me').historyId;
}

/** Compare two decimal historyId strings numerically (they can exceed 2^53). */
function s19_gt_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

function s19_err_(e) {
  return {
    name: e && e.name,
    message: String(e && e.message),
    code: e && e.details && e.details.code
  };
}

/**
 * Serialize, scrub the test account's address (and any plus-address or bare
 * local part followed by @domain), log, and return the scrubbed object.
 */
function s19_out_(result, ctx) {
  var json = JSON.stringify(result);
  var address = ctx ? ctx.address : Gmail.Users.getProfile('me').emailAddress;
  var at = address.lastIndexOf('@');
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var re = new RegExp(esc(address.slice(0, at)) + '(\\+[^@\\s"<>]*)?@' + esc(address.slice(at + 1)), 'gi');
  json = json.replace(re, function (_, plus) { return '<test-account>' + (plus || ''); });
  console.log(json);
  return JSON.parse(json);
}
