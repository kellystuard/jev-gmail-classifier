/**
 * Spike #25: nested label creation and label ID lookup through the Advanced
 * Gmail Service.
 *
 * Every test label contains "S25" (case-insensitive), and every label this
 * spike creates is also tracked by ID in the Script Property s25.created, so
 * s25_cleanup() deletes only this spike's labels. The test thread is imported
 * with placeholder addresses on example.test; the test account's address is
 * never read.
 *
 * Run order: s25_setup, s25_runLabelCases, s25_applyCases, (maintainer's UI
 * observations), s25_cleanup, s25_listSpikeLabels.
 */

var S25_MAX_TEXT = 600;

// ---------------------------------------------------------------------------
// Runnable functions
// ---------------------------------------------------------------------------

/** Import one synthetic test thread into the Inbox; store and return its ID. */
function s25_setup() {
  var result = { fn: 's25_setup', at: new Date().toISOString() };
  var raw = [
    'From: S25 Sender <s25-sender@example.test>',
    'To: S25 Recipient <s25-to@example.test>',
    'Subject: S25 nested label test thread',
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <s25-' + Date.now() + '@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Synthetic message for spike #25 (nested labels).',
    ''
  ].join('\r\n');
  result.import = s25_import_(raw, ['INBOX', 'UNREAD']);
  if (result.import.ok) {
    PropertiesService.getScriptProperties().setProperty('s25.threadId', result.import.threadId);
    result.threadId = result.import.threadId;
  }
  return s25_out_(result);
}

/** Cases 1–11: label creation, duplicates, case, reserved names, odd forms, visibility, list shape. */
function s25_runLabelCases() {
  var result = { fn: 's25_runLabelCases', at: new Date().toISOString(), cases: [] };
  var add = function (c) { result.cases.push(c); };

  // 1: no parents exist
  add(s25_group_(1, 'No parents exist', function (steps) {
    steps.push(s25_create_('S25none/B/C'));
  }));

  // 2: were parents auto-created? Then create them explicitly.
  add(s25_group_(2, 'Were parents auto-created?', function (steps) {
    var names = s25_spikeLabels_().labels.map(function (l) { return l.name; });
    steps.push({
      input: 'labels.list: look for S25none and S25none/B',
      result: {
        S25none: names.indexOf('S25none') !== -1,
        'S25none/B': names.indexOf('S25none/B') !== -1
      }
    });
    steps.push(s25_create_('S25none/B'));
    steps.push(s25_create_('S25none'));
  }));

  // 3: only the top parent exists
  add(s25_group_(3, 'Only the top parent exists', function (steps) {
    steps.push(s25_create_('S25some'));
    steps.push(s25_create_('S25some/B/C'));
  }));

  // 4: all parents exist
  add(s25_group_(4, 'All parents exist', function (steps) {
    steps.push(s25_create_('S25all'));
    steps.push(s25_create_('S25all/B'));
    steps.push(s25_create_('S25all/B/C'));
  }));

  // 5: exact duplicate
  add(s25_group_(5, 'Exact duplicate', function (steps) {
    steps.push(s25_create_('S25all/B/C'));
  }));

  // 6: case variants
  add(s25_group_(6, 'Case variant', function (steps) {
    steps.push(s25_create_('s25all/b/c'));
    steps.push(s25_create_('S25ALL'));
  }));

  // 7: system-name clashes
  add(s25_group_(7, 'System-name clash', function (steps) {
    ['Inbox', 'INBOX', 'inbox', 'Spam', 'Trash', 'Sent', 'Drafts', 'Starred',
      'Important', 'Unread', 'Chats', 'Social'].forEach(function (name) {
      steps.push(s25_create_(name));
    });
  }));

  // 8: nested under a system name
  add(s25_group_(8, 'Nested under a system name', function (steps) {
    steps.push(s25_create_('Inbox/S25x'));
    steps.push(s25_create_('Spam/S25x'));
  }));

  // 9: odd forms
  add(s25_group_(9, 'Odd forms', function (steps) {
    ['S25odd/', '/S25odd', 'S25odd//X', 'S25odd / X', 'S25odd/ X'].forEach(function (name) {
      steps.push(s25_create_(name));
    });
  }));

  // 10: default visibility
  add(s25_group_(10, 'Default visibility', function (steps) {
    steps.push(s25_create_('S25vis'));
    steps.push(s25_create_('S25vis2', { labelListVisibility: 'labelShow', messageListVisibility: 'show' }));
  }));

  // 11: list shape
  var listing = s25_try_(function () {
    var resp = Gmail.Users.Labels.list('me');
    var all = resp.labels || [];
    var spike = all.filter(s25_isSpikeName_).map(s25_pick_);
    return {
      responseKeys: Object.keys(resp),
      hasNextPageToken: resp.nextPageToken !== undefined && resp.nextPageToken !== null,
      totalLabels: all.length,
      userIdsAllMatchLabel_N: all.filter(function (l) { return l.type === 'user'; })
        .every(function (l) { return /^Label_\d+$/.test(l.id); }),
      systemIdsSample: all.filter(function (l) { return l.type === 'system'; })
        .map(function (l) { return l.id; }),
      spikeLabels: spike
    };
  });
  add({ case: 11, title: 'List shape', result: listing });

  return s25_out_(result);
}

/**
 * Cases 12–14: apply labels to the test thread by ID, by name, and by an
 * unknown ID. threadId defaults to the one s25_setup stored.
 */
function s25_applyCases(threadId) {
  threadId = threadId || PropertiesService.getScriptProperties().getProperty('s25.threadId');
  var result = { fn: 's25_applyCases', at: new Date().toISOString(), threadId: threadId, cases: [] };
  if (!threadId) {
    result.error = 'No threadId: run s25_setup first, or pass one.';
    return s25_out_(result);
  }
  result.threadBefore = s25_threadLabels_(threadId);

  // 12a: create S25apply/X/Y (no parents) and apply it by ID in the same execution.
  var c12 = { case: 12, title: 'Apply by ID', steps: [] };
  var created = s25_create_('S25apply/X/Y');
  c12.steps.push(created);
  var newId = created.result.ok ? created.result.label.id : null;
  if (!newId) {
    // Fallback: create the parents first, then the child, and still apply in this execution.
    c12.steps.push(s25_create_('S25apply'));
    c12.steps.push(s25_create_('S25apply/X'));
    var retry = s25_create_('S25apply/X/Y');
    c12.steps.push(retry);
    newId = retry.result.ok ? retry.result.label.id : null;
  }
  if (newId) {
    c12.steps.push(s25_modify_('new label S25apply/X/Y by ID', threadId, [newId]));
  }
  // 12b: apply the existing S25none/B/C by ID from labels.list.
  var existing = s25_spikeLabels_().labels.filter(function (l) { return l.name === 'S25none/B/C'; })[0];
  if (existing) {
    c12.steps.push(s25_modify_('existing S25none/B/C by ID (' + existing.id + ')', threadId, [existing.id]));
  } else {
    c12.steps.push({ input: 'existing S25none/B/C by ID', result: { ok: false, error: 'S25none/B/C not found in labels.list' } });
  }
  c12.threadAfter = s25_threadLabels_(threadId);
  result.cases.push(c12);

  // 13: apply by name
  var c13 = { case: 13, title: 'Apply by name', steps: [s25_modify_('name S25none/B/C', threadId, ['S25none/B/C'])] };
  c13.threadAfter = s25_threadLabels_(threadId);
  result.cases.push(c13);

  // 14: apply an unknown ID
  var c14 = { case: 14, title: 'Apply unknown ID', steps: [s25_modify_('unknown ID Label_999999999', threadId, ['Label_999999999'])] };
  c14.threadAfter = s25_threadLabels_(threadId);
  result.cases.push(c14);

  result.labelNames = s25_idToName_();
  return s25_out_(result);
}

/** Every label whose name contains "S25" (any case), plus any tracked ID. */
function s25_listSpikeLabels() {
  var result = { fn: 's25_listSpikeLabels', at: new Date().toISOString() };
  var listed = s25_spikeLabels_();
  result.ok = listed.ok;
  if (!listed.ok) result.error = listed.error;
  result.labels = listed.labels;
  result.count = listed.labels.length;
  return s25_out_(result);
}

/** Delete every S25 label (deepest names first). Leaves the imported test thread. */
function s25_cleanup() {
  var props = PropertiesService.getScriptProperties();
  var result = { fn: 's25_cleanup', at: new Date().toISOString(), deleted: [], failed: [] };
  var listed = s25_spikeLabels_();
  if (!listed.ok) {
    result.error = listed.error;
    return s25_out_(result);
  }
  var labels = listed.labels.slice().sort(function (a, b) {
    return b.name.split('/').length - a.name.split('/').length || b.name.length - a.name.length;
  });
  labels.forEach(function (l) {
    var r = s25_try_(function () {
      s25_removeLabel_(l.id);
      return 'ok';
    });
    if (r.ok) result.deleted.push({ id: l.id, name: l.name });
    else result.failed.push({ id: l.id, name: l.name, error: r.error });
  });
  // Keep the tracked IDs if anything failed, so a re-run still finds non-S25 names (case 7).
  if (result.failed.length === 0) props.deleteProperty('s25.created');
  result.after = s25_spikeLabels_().labels;
  return s25_out_(result);
}

// ---------------------------------------------------------------------------
// Helpers (trailing underscore: hidden from the editor dropdown and scripts.run)
// ---------------------------------------------------------------------------

/** A case group: list S25 labels before and after, and report labels that appeared without a create for them. */
function s25_group_(n, title, body) {
  var before = s25_spikeLabels_().labels;
  var steps = [];
  var bodyResult = s25_try_(function () { body(steps); return 'done'; });
  var after = s25_spikeLabels_().labels;
  var beforeIds = before.map(function (l) { return l.id; });
  var createdIds = steps.filter(function (s) { return s.result && s.result.ok && s.result.label; })
    .map(function (s) { return s.result.label.id; });
  var appeared = after.filter(function (l) {
    return beforeIds.indexOf(l.id) === -1 && createdIds.indexOf(l.id) === -1;
  }).map(function (l) { return l.name; });
  var c = {
    case: n,
    title: title,
    listBefore: before.map(function (l) { return l.name; }),
    steps: steps,
    listAfter: after.map(function (l) { return l.name; }),
    appearedWithoutCreate: appeared
  };
  if (!bodyResult.ok) c.unexpectedError = bodyResult.error;
  return c;
}

/** labels.create with only a name (plus optional fields); record the result and track the ID. */
function s25_create_(name, extra) {
  var resource = { name: name };
  Object.keys(extra || {}).forEach(function (k) { resource[k] = extra[k]; });
  var r = s25_try_(function () {
    return Gmail.Users.Labels.create(resource, 'me');
  });
  var step = { input: 'create ' + JSON.stringify(resource) };
  if (r.ok) {
    step.result = { ok: true, label: s25_pick_(r.value) };
    s25_track_(r.value.id);
  } else {
    step.result = r;
  }
  return step;
}

function s25_modify_(what, threadId, addLabelIds) {
  var r = s25_try_(function () {
    var t = Gmail.Users.Threads.modify({ addLabelIds: addLabelIds }, 'me', threadId);
    return { id: t.id };
  });
  return { input: 'threads.modify addLabelIds ' + JSON.stringify(addLabelIds) + ' (' + what + ')', result: r };
}

/** Per-message labelIds of a thread (format: minimal). */
function s25_threadLabels_(threadId) {
  return s25_try_(function () {
    var t = Gmail.Users.Threads.get('me', threadId, { format: 'minimal' });
    return (t.messages || []).map(function (m) { return { id: m.id, labelIds: m.labelIds || [] }; });
  });
}

/** Labels whose name contains S25 (any case), or whose ID this spike created. */
function s25_spikeLabels_() {
  var tracked = s25_tracked_();
  var r = s25_try_(function () {
    return (Gmail.Users.Labels.list('me').labels || []).filter(function (l) {
      return s25_isSpikeName_(l) || tracked.indexOf(l.id) !== -1;
    }).map(s25_pick_);
  });
  return r.ok ? { ok: true, labels: r.value } : { ok: false, labels: [], error: r.error };
}

function s25_isSpikeName_(l) {
  return /s25/i.test(l.name || '');
}

/** Map of ID to name for the thread's labels, so case 12–14 results can be read. */
function s25_idToName_() {
  var r = s25_try_(function () {
    var map = {};
    (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) {
      if (l.type === 'user' && s25_isSpikeName_(l)) map[l.id] = l.name;
    });
    return map;
  });
  return r.ok ? r.value : r;
}

function s25_pick_(l) {
  return {
    id: l.id,
    name: l.name,
    type: l.type,
    labelListVisibility: l.labelListVisibility === undefined ? '(absent)' : l.labelListVisibility,
    messageListVisibility: l.messageListVisibility === undefined ? '(absent)' : l.messageListVisibility
  };
}

function s25_tracked_() {
  var v = PropertiesService.getScriptProperties().getProperty('s25.created');
  try { return v ? JSON.parse(v) : []; } catch (e) { return []; }
}

function s25_track_(id) {
  var ids = s25_tracked_();
  if (ids.indexOf(id) === -1) ids.push(id);
  PropertiesService.getScriptProperties().setProperty('s25.created', JSON.stringify(ids));
}

/** Labels.remove (the Advanced Service's name for labels.delete); falls back to ['delete'] if absent. */
function s25_removeLabel_(id) {
  if (typeof Gmail.Users.Labels.remove === 'function') return Gmail.Users.Labels.remove('me', id);
  return Gmail.Users.Labels['delete']('me', id);
}

/** Run fn; return {ok: true, value} or {ok: false, error}. */
function s25_try_(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: s25_err_(e) };
  }
}

/** e.name, e.message verbatim, and e.details if present. */
function s25_err_(e) {
  var out = {
    name: e && e.name ? String(e.name) : typeof e,
    message: s25_cut_(e && e.message !== undefined ? String(e.message) : String(e))
  };
  if (e && e.details !== undefined) {
    try { out.details = JSON.parse(JSON.stringify(e.details)); } catch (err) { out.details = String(e.details); }
  }
  return out;
}

function s25_cut_(s) {
  return s.length > S25_MAX_TEXT ? s.slice(0, S25_MAX_TEXT) + '…[cut]' : s;
}

function s25_out_(result) {
  var text = JSON.stringify(result);
  console.log(text);
  return JSON.parse(text);
}

/**
 * Import one raw RFC 822 message. Tries the media-upload form
 * (resource, 'me', blob, options) first, then the resource.raw form.
 * The Advanced Service's import returns only {id} (observed 2026-09-26), so
 * the message is read back (format: minimal) for its threadId and labelIds.
 */
function s25_import_(raw, labelIds) {
  var opts = { neverMarkSpam: true, internalDateSource: 'dateHeader' };
  var attempts = [];
  var forms = [
    { method: 'import (media blob)', call: function () {
      return Gmail.Users.Messages.import({ labelIds: labelIds }, 'me', Utilities.newBlob(raw, 'message/rfc822'), opts);
    } },
    { method: 'import (resource.raw)', call: function () {
      return Gmail.Users.Messages.import(
        { labelIds: labelIds, raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8) }, 'me', null, opts);
    } }
  ];
  for (var i = 0; i < forms.length; i++) {
    var m;
    try {
      m = forms[i].call();
    } catch (e) {
      attempts.push({ method: forms[i].method, error: s25_err_(e) });
      continue;
    }
    var out = { ok: true, method: forms[i].method, importResponseKeys: Object.keys(m || {}), id: m && m.id };
    if (attempts.length) out.earlierAttempts = attempts;
    var got = s25_try_(function () { return Gmail.Users.Messages.get('me', m.id, { format: 'minimal' }); });
    if (got.ok) {
      out.threadId = got.value.threadId;
      out.labelIds = got.value.labelIds || [];
    } else {
      out.ok = false;
      out.readBackError = got.error;
    }
    return out;
  }
  return { ok: false, attempts: attempts };
}
