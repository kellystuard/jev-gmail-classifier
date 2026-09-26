/**
 * Spike #27: missing-scope errors and a detection approach for all four
 * declared scopes.
 *
 * Runs in its OWN Apps Script project ("Jev spike 27"), never in the shared
 * jev-spikes project: unticking scopes there would break the #163 runner.
 * The maintainer runs every function from the editor (consent screens can't
 * be automated, and scripts.run refuses a token that lacks a scope).
 *
 * Every runnable function returns a JSON-serializable result and logs it.
 * The test account's address is never returned or logged: the P5 recipient
 * comes from the Script Property S27_TO, and every result is scrubbed of it.
 */

var S27_DECLARED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.send_mail'
];

var S27_LABEL_NAME = 'S27/Probe';
var S27_TRIGGER_KEY_PREFIX = 's27.trig.';
var S27_TRIGGER_KEEP = 40; // stored trigger results kept (oldest dropped)
var S27_MAX_TEXT = 600; // long error text is cut to keep Script Properties small

// ---------------------------------------------------------------------------
// Runnable functions
// ---------------------------------------------------------------------------

/** B0 only: import one synthetic thread, create S27/Probe, store both IDs. */
function s27_setup() {
  var props = PropertiesService.getScriptProperties();
  var result = { fn: 's27_setup', at: new Date().toISOString() };

  var raw = [
    'From: S27 Probe <s27-probe@example.test>',
    'To: S27 Recipient <s27-to@example.test>',
    'Subject: S27 probe thread',
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <s27-' + Date.now() + '@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Synthetic message for spike #27 (missing-scope probes).',
    ''
  ].join('\r\n');

  result.import = s27_import_(raw, ['INBOX', 'UNREAD']);
  if (result.import.ok) {
    props.setProperty('s27.threadId', result.import.threadId);
  }

  result.label = s27_try_(function () {
    var existing = (Gmail.Users.Labels.list('me').labels || []).filter(function (l) {
      return l.name === S27_LABEL_NAME;
    })[0];
    var label = existing || Gmail.Users.Labels.create(
      { name: S27_LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      'me'
    );
    props.setProperty('s27.labelId', label.id);
    return { id: label.id, name: label.name, reused: !!existing };
  });

  result.s27ToSet = !!props.getProperty('S27_TO');
  return s27_out_(result);
}

/** Run every probe P1–P9 in this execution (editor context). */
function s27_probeAll() {
  return s27_out_(s27_probe_('editor'));
}

/** Create the every-minute trigger for s27_probeFromTrigger (removes any old one first). */
function s27_installProbeTrigger() {
  var result = { fn: 's27_installProbeTrigger', at: new Date().toISOString() };
  result.removed = s27_deleteTriggers_(['s27_probeFromTrigger']);
  result.create = s27_try_(function () {
    var t = ScriptApp.newTrigger('s27_probeFromTrigger').timeBased().everyMinutes(1).create();
    return { uniqueId: t.getUniqueId(), handler: t.getHandlerFunction() };
  });
  return s27_out_(result);
}

/** Delete the probe trigger and any leftover s27_noop trigger. */
function s27_removeProbeTrigger() {
  var result = { fn: 's27_removeProbeTrigger', at: new Date().toISOString() };
  result.removed = s27_deleteTriggers_(['s27_probeFromTrigger', 's27_noop']);
  return s27_out_(result);
}

/**
 * Trigger handler: same probes as s27_probeAll, but P5 sends at most one
 * email per consent state, and the result is stored in Script Properties
 * so s27_readTriggerResults can read it back. Then it calls requireScopes
 * for the missing scopes (table 5); the result is stored first, so an
 * execution that requireScopes ends loses nothing.
 */
function s27_probeFromTrigger(e) {
  var props = PropertiesService.getScriptProperties();
  var result = s27_probe_('trigger');
  if (e && e.triggerUid) result.triggerUid = String(e.triggerUid);
  var key = S27_TRIGGER_KEY_PREFIX + result.at;

  result.requireScopes = { stage: 'not called yet' };
  s27_store_(props, key, result);

  // Table 5 from the trigger. Mark before and after so a silent end shows up
  // as "called" with no "returned".
  var scopes = result.missingForRequire;
  if (scopes.length === 0) {
    result.requireScopes = { stage: 'skipped', reason: 'no declared scope is missing' };
  } else {
    result.requireScopes = { stage: 'called', scopes: scopes };
    s27_store_(props, key, result);
    var outcome = s27_try_(function () {
      ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, scopes);
      return 'returned';
    });
    result.requireScopes = { stage: 'after', scopes: scopes, outcome: outcome };
  }
  s27_store_(props, key, result);
  s27_trimStored_(props);
  return s27_out_(result);
}

/** Return the stored trigger results, oldest first. Each is also logged on its own line. */
function s27_readTriggerResults() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var keys = Object.keys(all).filter(function (k) {
    return k.indexOf(S27_TRIGGER_KEY_PREFIX) === 0;
  }).sort();
  var entries = keys.map(function (k) {
    var v = all[k];
    try { return JSON.parse(v); } catch (err) { return { key: k, unparsed: v }; }
  });
  entries.forEach(function (entry) {
    console.log(s27_scrub_(JSON.stringify(entry)));
  });
  var result = { fn: 's27_readTriggerResults', at: new Date().toISOString(), count: entries.length, entries: entries };
  var text = s27_scrub_(JSON.stringify(result));
  return JSON.parse(text);
}

/** Table 5 (editor) and table 6 (b): ScriptApp.requireScopes for the missing scopes. */
function s27_tryRequireScopes() {
  var result = { fn: 's27_tryRequireScopes', at: new Date().toISOString() };
  var missing = s27_missing_();
  result.detection = missing.how;
  result.scopes = missing.scopes;
  console.log('s27_tryRequireScopes: calling requireScopes with ' + JSON.stringify(missing.scopes) +
    '. If no result line follows, the call ended the execution.');
  result.outcome = s27_try_(function () {
    ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, missing.scopes);
    return 'returned';
  });
  return s27_out_(result);
}

/** Table 6 (b): ScriptApp.requireAllScopes. */
function s27_tryRequireAllScopes() {
  var result = { fn: 's27_tryRequireAllScopes', at: new Date().toISOString() };
  console.log('s27_tryRequireAllScopes: calling requireAllScopes. ' +
    'If no result line follows, the call ended the execution.');
  result.outcome = s27_try_(function () {
    ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
    return 'returned';
  });
  return s27_out_(result);
}

/**
 * Table 6 (c): logs the authorization URL on its own line for the maintainer
 * to open. Don't paste that line into the PR; the returned result only says
 * whether a URL exists.
 */
function s27_authUrl() {
  var result = { fn: 's27_authUrl', at: new Date().toISOString() };
  result.info = s27_try_(function () {
    var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, S27_DECLARED_SCOPES);
    var url = info.getAuthorizationUrl();
    if (url) console.log('Open this URL in the browser (do not paste it into the PR): ' + url);
    return { status: String(info.getAuthorizationStatus()), hasUrl: !!url };
  });
  return s27_out_(result);
}

/** Table 6 (e): ScriptApp.invalidateAuth(). Run it, then run s27_probeAll and note whether consent comes back. */
function s27_invalidateAuth() {
  var result = { fn: 's27_invalidateAuth', at: new Date().toISOString() };
  result.outcome = s27_try_(function () {
    ScriptApp.invalidateAuth();
    return 'returned';
  });
  return s27_out_(result);
}

/** With full consent: remove S27/Probe from the thread, delete the label, clear s27.* state. */
function s27_cleanup() {
  var props = PropertiesService.getScriptProperties();
  var result = { fn: 's27_cleanup', at: new Date().toISOString() };
  var labelId = props.getProperty('s27.labelId');
  var threadId = props.getProperty('s27.threadId');
  if (labelId && threadId) {
    result.unlabel = s27_try_(function () {
      Gmail.Users.Threads.modify({ removeLabelIds: [labelId] }, 'me', threadId);
      return 'ok';
    });
  }
  if (labelId) {
    result.deleteLabel = s27_try_(function () {
      Gmail.Users.Labels.remove('me', labelId);
      return 'ok';
    });
  }
  var keys = Object.keys(props.getProperties()).filter(function (k) {
    return k.indexOf('s27.') === 0;
  });
  keys.forEach(function (k) { props.deleteProperty(k); });
  result.deletedPropertyKeys = keys.length;
  result.note = 'S27_TO is left for the maintainer to delete with the project.';
  return s27_out_(result);
}

/** Handler for P7's one-off trigger. Never expected to fire (P7 deletes it at once). */
function s27_noop() {
  return s27_out_({ fn: 's27_noop', at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function s27_probe_(context) {
  var props = PropertiesService.getScriptProperties();
  var result = { fn: context === 'trigger' ? 's27_probeFromTrigger' : 's27_probeAll', context: context, at: new Date().toISOString() };
  result.env = {
    timeZone: s27_try_(function () { return Session.getScriptTimeZone(); }),
    locale: s27_try_(function () { return Session.getActiveUserLocale(); })
  };
  var p = {};

  // P1: getAuthorizationInfo(FULL)
  p.P1 = s27_try_(function () {
    return s27_authInfo_(ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL));
  });

  // P2: getAuthorizationInfo(FULL, DECLARED_SCOPES)
  p.P2 = s27_try_(function () {
    return s27_authInfo_(ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, S27_DECLARED_SCOPES));
  });

  // The consent state, derived from P2 (or P1): which declared scopes are missing.
  var stateKey = s27_stateKey_(p);
  result.stateKey = stateKey;
  result.missingForRequire = s27_missingFrom_(p).scopes;

  // P3: getProfile (gmail.modify). Reduced to ok + historyId: never the address.
  p.P3 = s27_try_(function () {
    var profile = Gmail.Users.getProfile('me');
    return { historyId: String(profile.historyId) };
  });

  // P4: threads.modify (gmail.modify)
  p.P4 = s27_try_(function () {
    var labelId = props.getProperty('s27.labelId');
    var threadId = props.getProperty('s27.threadId');
    if (!labelId || !threadId) throw new Error('s27_setup has not stored s27.labelId / s27.threadId');
    var t = Gmail.Users.Threads.modify({ addLabelIds: [labelId] }, 'me', threadId);
    return { threadId: t.id, messages: (t.messages || []).length };
  });

  // P5: MailApp.sendEmail (script.send_mail). Trigger: once per consent state.
  var to = props.getProperty('S27_TO');
  var mailedKey = 's27.mailed.' + stateKey;
  if (!to) {
    p.P5 = { ok: false, skipped: 'Script Property S27_TO is not set' };
  } else if (context === 'trigger' && props.getProperty(mailedKey)) {
    p.P5 = { ok: null, skipped: 'already mailed from a trigger in this consent state', firstAt: props.getProperty(mailedKey) };
  } else {
    p.P5 = s27_try_(function () {
      MailApp.sendEmail(to, 'S27 probe', 'context=' + context + ' state=' + stateKey + ' at=' + result.at);
      return 'sent';
    });
    if (context === 'trigger' && p.P5.ok) props.setProperty(mailedKey, result.at);
  }

  // P6: getProjectTriggers (script.scriptapp)
  p.P6 = s27_try_(function () {
    return ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  });

  // P7: create a one-off trigger, then delete it (script.scriptapp)
  p.P7 = s27_try_(function () {
    var t = ScriptApp.newTrigger('s27_noop').timeBased().after(3600000).create();
    var created = { created: true, handler: t.getHandlerFunction() };
    ScriptApp.deleteTrigger(t);
    created.deleted = true;
    return created;
  });

  // P8: UrlFetchApp.fetch (script.external_request)
  p.P8 = s27_try_(function () {
    var r = UrlFetchApp.fetch('https://www.google.com/generate_204', { muteHttpExceptions: true });
    return { status: r.getResponseCode() };
  });

  // P9: the product's other services, one by one (no scope expected)
  p.P9 = {
    propertiesGet: s27_try_(function () { return props.getProperty('s27.threadId') ? 'value' : 'null'; }),
    propertiesSet: s27_try_(function () { props.setProperty('s27.p9', result.at); return 'ok'; }),
    lock: s27_try_(function () {
      var lock = LockService.getScriptLock();
      var got = lock.tryLock(0);
      if (got) lock.releaseLock();
      return { acquired: got };
    }),
    timeZone: s27_try_(function () { return Session.getScriptTimeZone(); }),
    sleep: s27_try_(function () { Utilities.sleep(10); return 'ok'; })
  };

  result.probes = p;
  return result;
}

// ---------------------------------------------------------------------------
// Helpers (trailing underscore: hidden from the editor dropdown and scripts.run)
// ---------------------------------------------------------------------------

/** Run fn; return {ok: true, value} or {ok: false, error}. */
function s27_try_(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: s27_err_(e) };
  }
}

/** e.name, e.message verbatim, e.details if present, and the first line of e.stack. */
function s27_err_(e) {
  var out = {
    name: e && e.name ? String(e.name) : typeof e,
    message: s27_cut_(e && e.message !== undefined ? String(e.message) : String(e))
  };
  if (e && e.details !== undefined) {
    try { out.details = JSON.parse(JSON.stringify(e.details)); } catch (err) { out.details = String(e.details); }
  }
  if (e && e.stack) out.stackFirstLine = s27_cut_(String(e.stack).split('\n')[0]);
  return out;
}

function s27_cut_(s) {
  return s.length > S27_MAX_TEXT ? s.slice(0, S27_MAX_TEXT) + '…[cut]' : s;
}

function s27_authInfo_(info) {
  var scopes = info.getAuthorizedScopes();
  scopes = scopes ? Array.prototype.slice.call(scopes).map(String) : scopes;
  return {
    status: String(info.getAuthorizationStatus()),
    authorizedScopes: scopes,
    authorizedScopesType: scopes === null ? 'null' : Object.prototype.toString.call(info.getAuthorizedScopes()),
    hasAuthorizationUrl: !!info.getAuthorizationUrl()
  };
}

/** Missing declared scopes, from P2's (else P1's) authorized scope list. */
function s27_missingFrom_(p) {
  var src = (p.P2 && p.P2.ok && p.P2.value.authorizedScopes) ? 'P2'
    : (p.P1 && p.P1.ok && p.P1.value.authorizedScopes) ? 'P1' : null;
  if (!src) return { how: 'unknown (P1 and P2 failed or gave no list): using all declared scopes', scopes: S27_DECLARED_SCOPES.slice() };
  var granted = p[src].value.authorizedScopes;
  return {
    how: 'declared minus ' + src + ' authorizedScopes',
    scopes: S27_DECLARED_SCOPES.filter(function (s) { return granted.indexOf(s) === -1; })
  };
}

function s27_missing_() {
  var p = {
    P1: s27_try_(function () { return s27_authInfo_(ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL)); }),
    P2: s27_try_(function () { return s27_authInfo_(ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, S27_DECLARED_SCOPES)); })
  };
  var m = s27_missingFrom_(p);
  if (m.scopes.length === 0) {
    m.how += ' (nothing missing: passing all declared scopes)';
    m.scopes = S27_DECLARED_SCOPES.slice();
  }
  return m;
}

/** A short name for the consent state: "all", "missing-<scope,...>", or "unknown". */
function s27_stateKey_(p) {
  var m = s27_missingFrom_(p);
  if (m.how.indexOf('unknown') === 0) return 'unknown';
  if (m.scopes.length === 0) return 'all';
  return 'missing-' + m.scopes.map(function (s) { return s.split('/').pop(); }).join(',');
}

function s27_deleteTriggers_(handlers) {
  return s27_try_(function () {
    var n = 0;
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (handlers.indexOf(t.getHandlerFunction()) !== -1) {
        ScriptApp.deleteTrigger(t);
        n++;
      }
    });
    return { deleted: n };
  });
}

function s27_store_(props, key, result) {
  props.setProperty(key, s27_scrub_(JSON.stringify(result)));
}

/** Keep only the newest S27_TRIGGER_KEEP stored trigger results. */
function s27_trimStored_(props) {
  var keys = Object.keys(props.getProperties()).filter(function (k) {
    return k.indexOf(S27_TRIGGER_KEY_PREFIX) === 0;
  }).sort();
  keys.slice(0, Math.max(0, keys.length - S27_TRIGGER_KEEP)).forEach(function (k) {
    props.deleteProperty(k);
  });
}

/** Replace the S27_TO address (the test account) with <test-account>. */
function s27_scrub_(text) {
  var to = null;
  try { to = PropertiesService.getScriptProperties().getProperty('S27_TO'); } catch (err) { to = null; }
  if (!to) return text;
  var escaped = to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), '<test-account>');
}

/** Scrub, log, and return a result. */
function s27_out_(result) {
  var text = s27_scrub_(JSON.stringify(result));
  console.log(text);
  return JSON.parse(text);
}

/**
 * Import one raw RFC 822 message. Tries the documented media-upload form
 * first (resource, 'me', blob, options), then the resource.raw form.
 */
function s27_import_(raw, labelIds) {
  var opts = { neverMarkSpam: true, internalDateSource: 'dateHeader' };
  var attempts = [];
  try {
    var blob = Utilities.newBlob(raw, 'message/rfc822');
    var m = Gmail.Users.Messages.import({ labelIds: labelIds }, 'me', blob, opts);
    return { ok: true, method: 'import (media blob)', id: m.id, threadId: m.threadId, labelIds: m.labelIds || [] };
  } catch (e) {
    attempts.push({ method: 'import (media blob)', error: s27_err_(e) });
  }
  try {
    var m2 = Gmail.Users.Messages.import(
      { labelIds: labelIds, raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8) }, 'me', null, opts);
    return { ok: true, method: 'import (resource.raw)', id: m2.id, threadId: m2.threadId, labelIds: m2.labelIds || [], earlierAttempts: attempts };
  } catch (e2) {
    attempts.push({ method: 'import (resource.raw)', error: s27_err_(e2) });
  }
  return { ok: false, attempts: attempts };
}
