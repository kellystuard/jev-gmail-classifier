/**
 * s30: Gmail quota accounting for the Advanced Gmail Service (task #30,
 * story #28). The quota is never exhausted (maintainer's decision, epic #7):
 * this spike proves a persisted daily Gmail-call tally and samples latency.
 *
 * Runnable functions (each returns a JSON-serializable, address-free result
 * and also logs it):
 *   s30_tick(n, useLock)          n cheap Gmail calls (getProfile) through the counter.
 *   s30_simulateDayChange(day)    One tick as if today were `day` (default: tomorrow).
 *   s30_installTickTrigger()      One-off trigger in 60 s that runs s30_triggerTick.
 *   s30_triggerTick(e)            Trigger handler: tick(5), saves its result, deletes its trigger.
 *   s30_readTriggerResult()       The saved trigger result.
 *   s30_readCounter()             The stored counter.
 *   s30_measureLatency(n, ups)    Times n calls of each kind (default 20), first discarded,
 *                                 paced to ups quota units per second (default 25).
 *   s30_cleanup(removeLabel)      Deletes s30.* properties and s30_ triggers (and the label).
 *
 * Conventions (spikes/README.md): top-level names start with s30_, Script
 * Properties keys start with s30., no GmailApp. Helpers end in "_" so they are
 * private. The task text names the keys spike.gmailCalls and
 * spike.s30.triggerResult; they are s30.gmailCalls and s30.triggerResult here,
 * to keep to the shared project's key prefix rule.
 *
 * getProfile's response includes the account's address. It is never returned
 * or logged: only historyId is read from it.
 */

var s30_PROP_COUNTER = 's30.gmailCalls';
var s30_PROP_TRIGGER_RESULT = 's30.triggerResult';
var s30_PROP_THREADS = 's30.threads';
var s30_LABEL = 'Spike/Quota';
var s30_TRIGGER_HANDLER = 's30_triggerTick';

/* ------------------------------------------------------------------ */
/* Runnable functions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Makes n getProfile calls through the counter and returns the counter before
 * and after. useLock (default false) holds the script lock for the whole
 * execution, to compare concurrent runs with and without it.
 */
function s30_tick(n, useLock) {
  return s30_out_(s30_tick_(n || 3, null, !!useLock));
}

/** One tick as if today were `day` (YYYY-MM-DD; default tomorrow in the script's time zone). */
function s30_simulateDayChange(day) {
  var tz = Session.getScriptTimeZone();
  var simulated = day || Utilities.formatDate(new Date(Date.now() + 24 * 60 * 60 * 1000), tz, 'yyyy-MM-dd');
  var r = s30_tick_(1, simulated, false);
  r.realDay = s30_today_();
  r.simulatedDay = simulated;
  return s30_out_(r);
}

/** Creates a one-off trigger that runs s30_triggerTick about 60 s from now. */
function s30_installTickTrigger() {
  var removed = s30_deleteOwnTriggers_(null);
  PropertiesService.getScriptProperties().deleteProperty(s30_PROP_TRIGGER_RESULT);
  var t = ScriptApp.newTrigger(s30_TRIGGER_HANDLER).timeBased().after(60 * 1000).create();
  return s30_out_({
    installedAt: new Date().toISOString(),
    handler: s30_TRIGGER_HANDLER,
    triggerId: t.getUniqueId(),
    staleTriggersRemoved: removed,
    next: 'wait at least 2 minutes, then run s30_readTriggerResult and s30_readCounter'
  });
}

/**
 * Trigger handler. Runs tick(5), saves the result in s30.triggerResult
 * (console output from a trigger goes to Cloud Logging, not to the agent),
 * and deletes its own trigger.
 */
function s30_triggerTick(e) {
  var result;
  try {
    result = s30_tick_(5, null, false);
  } catch (err) {
    result = { error: String((err && err.message) || err).slice(0, 300) };
  }
  result.via = 'trigger';
  result.triggerUid = (e && e.triggerUid) || null;
  try {
    // Only this spike's handler is ever deleted; a one-off trigger is ours alone.
    result.triggersDeleted = s30_deleteOwnTriggers_(null);
  } catch (err2) {
    result.triggerDeleteError = String((err2 && err2.message) || err2).slice(0, 300);
  }
  PropertiesService.getScriptProperties().setProperty(s30_PROP_TRIGGER_RESULT, JSON.stringify(result));
  return s30_out_(result);
}

/** The result s30_triggerTick saved, or {pending: true}. Also lists any s30_ triggers still installed. */
function s30_readTriggerResult() {
  var raw = PropertiesService.getScriptProperties().getProperty(s30_PROP_TRIGGER_RESULT);
  var pending = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === s30_TRIGGER_HANDLER;
  }).length;
  return s30_out_({ result: raw ? JSON.parse(raw) : null, pending: !raw, s30TriggersInstalled: pending });
}

/** The stored counter, its size, and today's day in the script's time zone. */
function s30_readCounter() {
  var raw = PropertiesService.getScriptProperties().getProperty(s30_PROP_COUNTER);
  return s30_out_({
    counter: raw ? JSON.parse(raw) : null,
    counterBytes: raw ? raw.length : 0,
    today: s30_today_(),
    timeZone: Session.getScriptTimeZone()
  });
}

/**
 * Times n calls of each kind and returns min, median, p95, and max in ms,
 * after discarding the first (warm-up) call of each kind. Every call goes
 * through the counter. Creates its own synthetic threads (one 1-message, one
 * 5-message) and the Spike/Quota label on first use.
 */
function s30_measureLatency(n, unitsPerSecond) {
  var count = n || 20;
  // Paced to stay far below the per-user rate limit: the first, unpaced run
  // (2026-09-26) hit "Units per minute per user" after about 2,900 units in 18 s.
  var pace = unitsPerSecond || 25;
  var started = Date.now();
  var c = s30_counter_(null);
  var out = {
    executionId: Utilities.getUuid(), nPerKind: count, discarded: 1, pacedUnitsPerSecond: pace, counterBefore: c.before
  };
  // Runs fn, returns its elapsed ms, then sleeps so the call's units are spread at `pace`.
  function timed(units, fn) {
    var t0 = Date.now();
    var v = c.gmailCall(fn);
    var ms = Date.now() - t0;
    var wait = Math.ceil(units * 1000 / pace) - ms;
    if (wait > 0) Utilities.sleep(wait);
    return { ms: ms, value: v };
  }
  try {
    var threads = s30_setupThreads_(c);
    var labelId = s30_labelId_(c);
    out.setup = { created: threads.created, labelName: labelId.name };

    var small = threads.small;
    var multi = threads.multi;
    var startHistoryId = timed(40, function () {
      return Gmail.Users.Threads.get('me', small, { format: 'minimal' });
    }).value.historyId;

    // [call, params, units (Gmail API usage limits page), fn]
    var kinds = [
      ['getProfile', '', 1, function () { return Gmail.Users.getProfile('me').historyId; }],
      ['history.list', 'startHistoryId = the small thread\'s historyId', 2, function () {
        var r = Gmail.Users.History.list('me', { startHistoryId: startHistoryId });
        return ((r && r.history) || []).length;
      }],
      ['threads.list', 'q: in:inbox, maxResults: 100', 10, function () {
        var r = Gmail.Users.Threads.list('me', { q: 'in:inbox', maxResults: 100 });
        return ((r && r.threads) || []).length;
      }],
      ['threads.get', 'format: metadata, metadataHeaders: [Subject], 1-message thread', 40, function () {
        return Gmail.Users.Threads.get('me', small, { format: 'metadata', metadataHeaders: ['Subject'] }).messages.length;
      }],
      ['threads.get', 'format: full, 1-message thread', 40, function () {
        return Gmail.Users.Threads.get('me', small, { format: 'full' }).messages.length;
      }],
      ['threads.get', 'format: full, 5-message thread', 40, function () {
        return Gmail.Users.Threads.get('me', multi, { format: 'full' }).messages.length;
      }]
    ];
    out.results = [];
    kinds.forEach(function (k) {
      var times = [];
      var sample = null;
      for (var i = 0; i < count; i++) {
        var r0 = timed(k[2], k[3]);
        times.push(r0.ms);
        if (i === 0) sample = r0.value;
      }
      var r = s30_stats_(times.slice(1));
      r.call = k[0];
      r.params = k[1];
      r.units = k[2];
      r.firstCallMs = times[0];
      r.resultSize = sample;
      out.results.push(r);
    });

    // threads.modify: add the label, then remove it; timed separately.
    var add = [];
    var remove = [];
    for (var j = 0; j < count; j++) {
      add.push(timed(10, function () { return Gmail.Users.Threads.modify({ addLabelIds: [labelId.id] }, 'me', small); }).ms);
      remove.push(timed(10, function () { return Gmail.Users.Threads.modify({ removeLabelIds: [labelId.id] }, 'me', small); }).ms);
    }
    [['threads.modify', 'addLabelIds: [Spike/Quota]', add], ['threads.modify', 'removeLabelIds: [Spike/Quota]', remove]]
      .forEach(function (m) {
        var r = s30_stats_(m[2].slice(1));
        r.call = m[0];
        r.params = m[1];
        r.units = 10;
        r.firstCallMs = m[2][0];
        out.results.push(r);
      });
  } catch (e) {
    // Keep the partial results, and don't leak the Cloud project number.
    out.error = String((e && e.message) || e).replace(/project_number:\d+/g, 'project_number:<project-number>').slice(0, 400);
  } finally {
    out.counterBytes = c.save();
  }
  out.gmailCallsThisExecution = c.calls();
  out.counterAfter = c.state();
  out.durationMs = Date.now() - started;
  return s30_out_(out);
}

/** Deletes s30.* Script Properties and s30_ triggers. removeLabel also deletes Spike/Quota. */
function s30_cleanup(removeLabel) {
  var props = PropertiesService.getScriptProperties();
  var deleted = props.getKeys().filter(function (k) { return k.indexOf('s30.') === 0; });
  deleted.forEach(function (k) { props.deleteProperty(k); });
  var triggers = s30_deleteOwnTriggers_(null);
  var label = null;
  if (removeLabel) {
    var labels = Gmail.Users.Labels.list('me').labels || [];
    labels.forEach(function (l) {
      if (l.name === s30_LABEL || l.name === 'Spike-Quota') {
        Gmail.Users.Labels.remove('me', l.id);
        label = l.name;
      }
    });
  }
  // These cleanup calls aren't counted: the counter was just deleted.
  return s30_out_({ deletedProperties: deleted, deletedTriggers: triggers, deletedLabel: label });
}

/* ------------------------------------------------------------------ */
/* The counter (the pattern the product would use)                     */
/* ------------------------------------------------------------------ */

/**
 * Loads the persisted daily counter once. gmailCall(fn) counts a call (before
 * making it: a call that throws may still have used quota) and returns fn's
 * result. save() writes the counter once, at the end of the execution.
 * dayOverride injects "today" (used by s30_simulateDayChange).
 */
function s30_counter_(dayOverride) {
  var props = PropertiesService.getScriptProperties();
  var today = dayOverride || s30_today_();
  var raw = props.getProperty(s30_PROP_COUNTER);
  var stored = raw ? JSON.parse(raw) : null;
  var reset = !!stored && stored.day !== today;
  var count = stored && stored.day === today ? stored.count : 0;
  var calls = 0;
  var readAt = new Date().toISOString();
  return {
    before: stored,
    reset: reset,
    readAt: readAt,
    today: today,
    gmailCall: function (fn) {
      calls++;
      count++;
      return fn();
    },
    calls: function () { return calls; },
    state: function () { return { day: today, count: count }; },
    save: function () {
      var v = JSON.stringify({ day: today, count: count });
      props.setProperty(s30_PROP_COUNTER, v);
      return v.length;
    }
  };
}

function s30_tick_(n, dayOverride, useLock) {
  var executionId = Utilities.getUuid();
  var lock = null;
  var lockWaitMs = null;
  if (useLock) {
    var w0 = Date.now();
    lock = LockService.getScriptLock();
    lock.waitLock(120000);
    lockWaitMs = Date.now() - w0;
  }
  try {
    var c = s30_counter_(dayOverride);
    var bytes;
    try {
      for (var i = 0; i < n; i++) {
        // Only historyId is kept: the profile also holds the account's address.
        c.gmailCall(function () { return Gmail.Users.getProfile('me').historyId; });
      }
    } finally {
      bytes = c.save();
    }
    return {
      executionId: executionId,
      n: n,
      day: c.today,
      before: c.before,
      resetForNewDay: c.reset,
      after: c.state(),
      counterBytes: bytes,
      readAt: c.readAt,
      writtenAt: new Date().toISOString(),
      useLock: !!useLock,
      lockWaitMs: lockWaitMs
    };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function s30_today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* ------------------------------------------------------------------ */
/* Latency helpers                                                     */
/* ------------------------------------------------------------------ */

/** {n, min, median, p95, max} in ms. p95 is nearest-rank. */
function s30_stats_(times) {
  var s = times.slice().sort(function (a, b) { return a - b; });
  var len = s.length;
  if (!len) return { n: 0 };
  var mid = Math.floor(len / 2);
  return {
    n: len,
    min: s[0],
    median: len % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    p95: s[Math.max(0, Math.ceil(0.95 * len) - 1)],
    max: s[len - 1]
  };
}

/**
 * The spike's own synthetic threads: `small` (1 message) and `multi`
 * (5 messages, threaded with threadId, In-Reply-To, References, and the same
 * Subject). Created once and saved in s30.threads.
 */
function s30_setupThreads_(c) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(s30_PROP_THREADS);
  if (raw) {
    var saved = JSON.parse(raw);
    saved.created = false;
    return saved;
  }
  var nonce = String(Date.now());
  var small = s30_insert_(c, s30_mime_('s30 latency small thread', '<s30-small.' + nonce + '@example.com>', null, 1), null);
  var firstId = '<s30-multi-1.' + nonce + '@example.com>';
  var first = s30_insert_(c, s30_mime_('s30 latency multi thread', firstId, null, 1), null);
  var refs = [firstId];
  for (var i = 2; i <= 5; i++) {
    var id = '<s30-multi-' + i + '.' + nonce + '@example.com>';
    s30_insert_(c, s30_mime_('Re: s30 latency multi thread', id, refs, i), first.threadId);
    refs.push(id);
  }
  var threads = { small: small.threadId, multi: first.threadId };
  props.setProperty(s30_PROP_THREADS, JSON.stringify(threads));
  threads.created = true;
  return threads;
}

function s30_mime_(subject, messageId, references, n) {
  var lines = [
    'From: Synthetic Sender <sender@example.com>',
    'To: Recipient <recipient@example.org>',
    'Subject: ' + subject,
    'Date: Thu, 24 Sep 2026 12:0' + n + ':00 +0000',
    'Message-ID: ' + messageId
  ];
  if (references) {
    lines.push('In-Reply-To: ' + references[references.length - 1]);
    lines.push('References: ' + references.join(' '));
  }
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 7bit', '',
    'Synthetic message ' + n + ' for the s30 latency sample.', '');
  return lines.join('\r\n');
}

/** messages.insert with a base64url `raw`; falls back to a message/rfc822 blob. */
function s30_insert_(c, mime, threadId) {
  var resource = { labelIds: ['INBOX'] };
  if (threadId) resource.threadId = threadId;
  var opts = { internalDateSource: 'dateHeader' };
  try {
    var withRaw = JSON.parse(JSON.stringify(resource));
    withRaw.raw = Utilities.base64EncodeWebSafe(mime);
    return c.gmailCall(function () { return Gmail.Users.Messages.insert(withRaw, 'me', null, opts); });
  } catch (e) {
    var blob = Utilities.newBlob(mime, 'message/rfc822', 'message.eml');
    return c.gmailCall(function () { return Gmail.Users.Messages.insert(resource, 'me', blob, opts); });
  }
}

/** Finds or creates the Spike/Quota label (Spike-Quota if the nested name is refused). */
function s30_labelId_(c) {
  var labels = c.gmailCall(function () { return Gmail.Users.Labels.list('me').labels || []; });
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].name === s30_LABEL || labels[i].name === 'Spike-Quota') return { id: labels[i].id, name: labels[i].name };
  }
  var spec = { labelListVisibility: 'labelShow', messageListVisibility: 'show' };
  try {
    spec.name = s30_LABEL;
    var l = c.gmailCall(function () { return Gmail.Users.Labels.create(spec, 'me'); });
    return { id: l.id, name: l.name };
  } catch (e) {
    spec.name = 'Spike-Quota';
    var l2 = c.gmailCall(function () { return Gmail.Users.Labels.create(spec, 'me'); });
    return { id: l2.id, name: l2.name };
  }
}

/* ------------------------------------------------------------------ */
/* Shared-project hygiene and output                                   */
/* ------------------------------------------------------------------ */

/** Deletes this spike's own triggers (handler s30_triggerTick), or only the one with uid. Returns how many. */
function s30_deleteOwnTriggers_(uid) {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== s30_TRIGGER_HANDLER) return;
    if (uid && t.getUniqueId() !== uid) return;
    ScriptApp.deleteTrigger(t);
    n++;
  });
  return n;
}

function s30_out_(result) {
  var json = JSON.stringify(result);
  console.log(json);
  return JSON.parse(json);
}
