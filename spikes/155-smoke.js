/**
 * Smoke-test helper (#155): runs the release checklist (docs/smoke-test.md)
 * in the test account, for a person in the editor or an agent through
 * `node spikes/run.mjs`.
 *
 * It needs two more files in the same project, both built locally and never
 * committed (docs/smoke-test.md, "The two builds"):
 *
 * - the product bundle (`dist/Code.js`): the six entry points;
 * - the adapter bundle: the global `JevSmokeAdapters`.
 *
 * Rules this file keeps:
 *
 * - Every top-level name starts with `s155_`.
 * - Every runnable function returns a JSON result and logs it.
 * - Every result is scrubbed of the account's address, in its plain and its
 *   URL-encoded form. The address is read at run time and never written here.
 * - The Jev key is never returned or logged.
 * - It touches only its own things: the Script Properties `JEV_API_KEY`,
 *   `MANUAL_*`, `RESET_POSITION` and `state.*`; triggers for `onTrigger` and
 *   `s155_other`; labels named `JevSmoke…`, `Jev` and `Jev/Error`; synthetic
 *   mail (from `example.test`, subject `JevSmoke…`) and the classifier's own
 *   emails (subject `[Jev Gmail Classifier] …`, sent by the account itself).
 * - A log line about real mail has its `subject` and `from` replaced before
 *   it is returned, and is counted in `realMail`.
 */

var s155_K = {
  entryPoints: ['onTrigger', 'install', 'uninstall', 'startManualRun', 'continueManualRun', 'cancelManualRun'],
  triggerHandlers: ['onTrigger', 's155_other'],
  subject: 'JevSmoke',
  alertPrefix: '[Jev Gmail Classifier]',
  domain: 'example.test',
  labelBody: 'JevSmokeBody. This is a synthetic smoke-test message. It is not real mail.',
  archiveBody: 'JevSmokeBody. This is a synthetic smoke-test message. It is not real mail. Please archive this email.',
  excludeQuery: 'subject:JevSmokeExcluded OR (-from:example.test -subject:"Jev Gmail Classifier")',
  softLimitMs: 4.5 * 60 * 1000
};

// ---------------------------------------------------------------- output

function s155_address_() {
  return String(Gmail.Users.getProfile('me').emailAddress);
}

function s155_escape_(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The account's address as two patterns: plain and URL-encoded, plus-addresses included. */
function s155_addressPatterns_(address) {
  var at = address.lastIndexOf('@');
  var local = s155_escape_(address.slice(0, at));
  var domain = s155_escape_(address.slice(at + 1));
  return [
    new RegExp(local + '(\\+[\\w.-]*)?@' + domain, 'gi'),
    new RegExp(s155_escape_(encodeURIComponent(address.slice(0, at))) + '(%2B[\\w.-]*)?%40' + s155_escape_(encodeURIComponent(address.slice(at + 1))), 'gi')
  ];
}

function s155_scrubText_(text, address) {
  var out = String(text);
  s155_addressPatterns_(address).forEach(function (re) { out = out.replace(re, '<test-account>'); });
  return out;
}

/** Scrubs the address from a result, logs it and returns it. */
function s155_out_(result) {
  var text = JSON.stringify(result === undefined ? null : result);
  var clean = JSON.parse(s155_scrubText_(text, s155_address_()));
  console.log(JSON.stringify(clean));
  return clean;
}

function s155_error_(e) {
  var out = { name: String(e && e.name), message: String(e && e.message) };
  if (e && e.fields) out.fields = e.fields;
  if (e && e.cause !== undefined) out.cause = String(e.cause && e.cause.message !== undefined ? e.cause.message : e.cause);
  return out;
}

/** Runs one step and returns its value, or `{threw}`. */
function s155_try_(fn) {
  try {
    return fn();
  } catch (e) {
    return { threw: s155_error_(e) };
  }
}

function s155_adapters_() {
  if (typeof JevSmokeAdapters === 'undefined') throw new Error('The adapter bundle (JevSmokeAdapters) is not in the project.');
  return JevSmokeAdapters;
}

// ---------------------------------------------------------------- Script Properties

function s155_allowedProp_(name) {
  return name === 'JEV_API_KEY' || name === 'RESET_POSITION' || /^MANUAL_[A-Z_]+$/.test(name) || /^state\.[\w.]+$/.test(name);
}

function s155_utf8Bytes_(text) {
  return Utilities.newBlob(text).getBytes().length;
}

function s155_digest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); })
    .join('')
    .slice(0, 16);
}

/**
 * The classifier's properties. A value over `maxChars` is left out (its size
 * is still given). Other keys (another spike's) are never returned: only how
 * many there are and a digest of their names, to compare before and after.
 */
function s155_props_(maxChars) {
  var all = PropertiesService.getScriptProperties().getProperties();
  var limit = maxChars === undefined ? 3000 : maxChars;
  var props = {};
  var other = [];
  var queue = { shards: [], maxBytes: 0, manualItems: 0, items: 0 };
  Object.keys(all).sort().forEach(function (key) {
    if (key === 'JEV_API_KEY') return;
    if (!s155_allowedProp_(key)) {
      other.push(key);
      return;
    }
    var value = all[key];
    var bytes = s155_utf8Bytes_(value);
    props[key] = value.length > limit ? { bytes: bytes, omitted: true, starts: value.slice(0, 12) } : { bytes: bytes, value: value };
    if (/^state\.queue\.\d+$/.test(key)) {
      queue.shards.push(Number(key.slice('state.queue.'.length)));
      queue.maxBytes = Math.max(queue.maxBytes, bytes);
      queue.manualItems += (value.match(/"source":"manual"/g) || []).length;
      queue.items += (value.match(/"threadId":/g) || []).length;
    }
  });
  queue.shards.sort(function (a, b) { return a - b; });
  return {
    jevKeySet: typeof all.JEV_API_KEY === 'string' && all.JEV_API_KEY.trim() !== '',
    props: props,
    queue: queue,
    otherKeys: { count: other.length, namesDigest: s155_digest_(other.join('\n')) }
  };
}

/** The `state.*`, `MANUAL_*` and `RESET_POSITION` properties, and whether the key is set. */
function s155_props(maxChars) {
  return s155_out_(s155_props_(maxChars));
}

/** Sets one of the classifier's properties. Never returns a value. */
function s155_setProp(name, value) {
  if (!s155_allowedProp_(String(name))) return s155_out_({ set: false, refused: 'not one of the classifier\'s properties' });
  if (typeof value !== 'string') return s155_out_({ set: false, refused: 'the value must be a string' });
  PropertiesService.getScriptProperties().setProperty(name, value);
  return s155_out_({ set: true, name: name });
}

/** Deletes one of the classifier's properties. */
function s155_deleteProp(name) {
  if (!s155_allowedProp_(String(name))) return s155_out_({ deleted: false, refused: 'not one of the classifier\'s properties' });
  var props = PropertiesService.getScriptProperties();
  var existed = props.getProperty(name) !== null;
  props.deleteProperty(name);
  return s155_out_({ deleted: true, name: name, existed: existed });
}

// ---------------------------------------------------------------- triggers

function s155_triggers_() {
  return ScriptApp.getProjectTriggers()
    .map(function (t) {
      return { handler: t.getHandlerFunction(), kind: String(t.getEventType()), source: String(t.getTriggerSource()), id: t.getUniqueId() };
    })
    .sort(function (a, b) { return (a.handler + a.id).localeCompare(b.handler + b.id); });
}

/** Every project trigger's handler and kind. It only reads. */
function s155_triggers() {
  return s155_out_({ triggers: s155_triggers_() });
}

/** The checklist's "second handler": a function that does nothing. */
function s155_other() {
  return null;
}

/**
 * Creates (`create`: hourly) or deletes (`delete`) triggers, for the handlers
 * `onTrigger` and `s155_other` only. It deletes the copies from
 * `getProjectTriggers()`, never the object `create()` returned (E1 #163).
 */
function s155_trigger(action, handler) {
  handler = handler || 's155_other';
  if (s155_K.triggerHandlers.indexOf(handler) < 0) return s155_out_({ refused: 'only onTrigger and s155_other' });
  var result = { action: action, handler: handler };
  if (action === 'create') {
    ScriptApp.newTrigger(handler).timeBased().everyHours(1).create();
    result.created = 1;
  } else if (action === 'delete') {
    var deleted = 0;
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === handler) {
        ScriptApp.deleteTrigger(t);
        deleted += 1;
      }
    });
    result.deleted = deleted;
  } else {
    result.refused = 'action is create or delete';
  }
  result.triggers = s155_triggers_();
  return s155_out_(result);
}

// ---------------------------------------------------------------- entry points

/**
 * Runs one entry point and returns `{returned}` or `{threw}`, the log lines
 * it wrote, the time it took, and the properties and triggers afterwards.
 *
 * `opts.withoutKey`: delete `JEV_API_KEY` for the length of the call and put
 * it back afterwards. `opts.brief`: leave the `thread.*` lines out of `lines`
 * (they are still counted). `opts.maxChars`: see `s155_props_`.
 */
function s155_call(name, opts) {
  opts = opts || {};
  if (s155_K.entryPoints.indexOf(name) < 0) return s155_out_({ refused: 'name one of: ' + s155_K.entryPoints.join(', ') });
  var fn = globalThis[name];
  if (typeof fn !== 'function') return s155_out_({ refused: 'the product bundle is not in the project: ' + name + ' is not a function' });

  var address = s155_address_();
  var store = PropertiesService.getScriptProperties();
  var key = store.getProperty('JEV_API_KEY');
  var captured = [];
  var original = {};
  var levels = ['info', 'warn', 'error'];
  var result = { entry: name };

  // `console.info = …` does nothing on Apps Script: the three methods are
  // own properties that are not writable but are configurable, so they are
  // redefined, and put back in the `finally` (s155_consoleProbe, 2026-10-01).
  levels.forEach(function (level) {
    original[level] = Object.getOwnPropertyDescriptor(console, level);
    var write = console[level];
    Object.defineProperty(console, level, {
      value: function () {
        captured.push({ level: level, text: String(arguments[0]) });
        return write.apply(console, arguments);
      },
      writable: false,
      configurable: true,
      enumerable: true
    });
  });
  result.consolePatched = levels.every(function (level) { return console[level] !== original[level].value; });
  if (opts.withoutKey) store.deleteProperty('JEV_API_KEY');
  result.before = Date.now();
  try {
    result.returned = fn();
  } catch (e) {
    result.threw = s155_error_(e);
  } finally {
    result.after = Date.now();
    levels.forEach(function (level) { Object.defineProperty(console, level, original[level]); });
    if (opts.withoutKey && key !== null) store.setProperty('JEV_API_KEY', key);
  }
  result.ms = result.after - result.before;
  result.log = s155_readLines_(captured, address, key, opts.brief === true);
  result.state = s155_props_(opts.maxChars);
  result.triggers = s155_triggers_();
  return s155_out_(result);
}

/**
 * What Apps Script lets a script do to `console` (first tried for #155). It
 * tries three ways to intercept `console.info` and reports which one a later
 * `console.info` call goes through. It restores what it changed.
 */
function s155_consoleProbe() {
  var describe = function (object, name) {
    var d = Object.getOwnPropertyDescriptor(object, name);
    return d ? { writable: d.writable, configurable: d.configurable, enumerable: d.enumerable, accessor: Boolean(d.get || d.set), type: typeof d.value } : null;
  };
  var out = {
    consoleType: Object.prototype.toString.call(console),
    globalDescriptor: describe(globalThis, 'console'),
    ownKeys: Object.getOwnPropertyNames(console).sort(),
    infoOwn: describe(console, 'info'),
    infoOnPrototype: describe(Object.getPrototypeOf(console) || {}, 'info'),
    frozen: Object.isFrozen(console),
    sealed: Object.isSealed(console),
    extensible: Object.isExtensible(console)
  };
  var hits = [];
  var original = console.info;
  var spy = function () { hits.push(String(arguments[0])); return original.apply(console, arguments); };

  out.assign = s155_try_(function () {
    console.info = spy;
    var took = console.info === spy;
    console.info('s155 probe: assign');
    console.info = original;
    return { took: took, hits: hits.length };
  });
  hits = [];
  out.defineProperty = s155_try_(function () {
    var before = Object.getOwnPropertyDescriptor(console, 'info');
    Object.defineProperty(console, 'info', { value: spy, writable: true, configurable: true, enumerable: true });
    var took = console.info === spy;
    console.info('s155 probe: defineProperty');
    if (before) Object.defineProperty(console, 'info', before);
    else delete console.info;
    return { took: took, hits: hits.length, restored: console.info === original };
  });
  hits = [];
  out.replaceGlobal = s155_try_(function () {
    var real = console;
    var fake = Object.create(real);
    fake.info = function () { hits.push(String(arguments[0])); return real.info.apply(real, arguments); };
    globalThis.console = fake;
    var took = console === fake;
    console.info('s155 probe: replaceGlobal');
    globalThis.console = real;
    return { took: took, hits: hits.length, restored: console === real };
  });
  return s155_out_(out);
}

function s155_onTrigger() { return s155_call('onTrigger'); }
function s155_install() { return s155_call('install'); }
function s155_uninstall() { return s155_call('uninstall'); }
function s155_startManualRun() { return s155_call('startManualRun'); }
function s155_continueManualRun() { return s155_call('continueManualRun'); }
function s155_cancelManualRun() { return s155_call('cancelManualRun'); }

function s155_count_(map, name) {
  map[name] = (map[name] || 0) + 1;
}

/**
 * Parses the captured lines and counts what the checks ask about, on the raw
 * text, before anything is replaced.
 */
function s155_readLines_(captured, address, key, brief) {
  var patterns = s155_addressPatterns_(address);
  var out = {
    count: captured.length,
    events: {},
    levels: {},
    notJson: 0,
    reservedFirst: 0,
    runIds: [],
    entries: [],
    tsAllUtc: true,
    tsMin: null,
    tsMax: null,
    forbidden: { body: 0, bearer: 0, key: 0, state: 0 },
    addressIn: {},
    realMail: {},
    classified: { count: 0, fired: {}, actions: {}, from: { synthetic: 0, own: 0, real: 0 } },
    lines: []
  };
  captured.forEach(function (entry) {
    var text = entry.text;
    if (text.indexOf('JevSmokeBody') >= 0) out.forbidden.body += 1;
    if (text.indexOf('Bearer') >= 0) out.forbidden.bearer += 1;
    if (key && key.length >= 8 && text.indexOf(key) >= 0) out.forbidden.key += 1;
    if (text.indexOf('"state":') >= 0) out.forbidden.state += 1;
    var line;
    try {
      line = JSON.parse(text);
    } catch (e) {
      out.notJson += 1;
      return;
    }
    if (line === null || typeof line !== 'object' || Array.isArray(line)) {
      out.notJson += 1;
      return;
    }
    var event = String(line.event);
    s155_count_(out.events, event);
    s155_count_(out.levels, event + ':' + entry.level);
    if (Object.keys(line).slice(0, 4).join(',') === 'event,runId,entry,ts') out.reservedFirst += 1;
    if (out.runIds.indexOf(line.runId) < 0) out.runIds.push(line.runId);
    if (out.entries.indexOf(line.entry) < 0) out.entries.push(line.entry);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(String(line.ts))) out.tsAllUtc = false;
    var ms = Date.parse(line.ts);
    if (out.tsMin === null || ms < out.tsMin) out.tsMin = ms;
    if (out.tsMax === null || ms > out.tsMax) out.tsMax = ms;
    if (patterns.some(function (re) { re.lastIndex = 0; return re.test(text); })) s155_count_(out.addressIn, event);

    var kind = null;
    if (typeof line.from === 'string') {
      patterns[0].lastIndex = 0;
      kind = line.from.indexOf('@' + s155_K.domain) >= 0 ? 'synthetic' : patterns[0].test(line.from) ? 'own' : 'real';
    }
    if (kind === 'real') {
      s155_count_(out.realMail, event);
      line.subject = '<real mail>';
      line.from = '<real mail>';
    }
    if (event === 'thread.classified') {
      out.classified.count += 1;
      if (kind) out.classified.from[kind] += 1;
      (line.fired || []).forEach(function (rule) { s155_count_(out.classified.fired, rule); });
      s155_count_(out.classified.actions, (line.actions || []).join(' + ') || '(none)');
    }
    if (brief && /^thread\./.test(event)) return;
    out.lines.push(Object.assign({ level: entry.level }, line));
  });
  return out;
}

// ---------------------------------------------------------------- synthetic mail

function s155_pad_(n, width) {
  var text = String(n);
  while (text.length < width) text = '0' + text;
  return text;
}

/** Retries a Gmail call on the per-user rate limit, which every spike shares. */
function s155_retry_(fn) {
  for (var attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      var rate = /Quota exceeded|rateLimitExceeded|User-rate limit/i.test(String(e && e.message));
      if (!rate || attempt > 3) throw e;
      Utilities.sleep(20000 * attempt);
    }
  }
}

/**
 * Imports one synthetic message (labels INBOX and UNREAD, neverMarkSpam).
 * `spec`: `{sender, subject, body, daysAgo, latin1}`. With `latin1`, the part
 * declares ISO-8859-1 and the body ends with `café` in that charset.
 */
function s155_importOne_(address, spec) {
  var date = new Date(Date.now() - (spec.daysAgo || 0) * 24 * 60 * 60 * 1000);
  var id = Utilities.getUuid();
  var body = spec.body + (spec.latin1 ? ' caf\u00e9' : '');
  var raw = [
    'From: Jev Smoke <' + spec.sender + '@' + s155_K.domain + '>',
    'To: <' + address + '>',
    'Subject: ' + spec.subject,
    'Date: ' + Utilities.formatDate(date, 'GMT', "EEE, dd MMM yyyy HH:mm:ss '+0000'"),
    'Message-ID: <s155-' + id + '@' + s155_K.domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=' + (spec.latin1 ? 'ISO-8859-1' : 'UTF-8'),
    'Content-Transfer-Encoding: ' + (spec.latin1 ? '8bit' : '7bit'),
    '',
    body,
    ''
  ].join('\r\n');
  var bytes = [];
  for (var i = 0; i < raw.length; i++) {
    var code = raw.charCodeAt(i);
    if (code > 255) throw new Error('A synthetic message must be Latin-1.');
    bytes.push(code > 127 ? code - 256 : code);
  }
  var blob = Utilities.newBlob(bytes, 'message/rfc822');
  var m = s155_retry_(function () {
    return Gmail.Users.Messages['import']({ labelIds: ['INBOX', 'UNREAD'] }, 'me', blob, { neverMarkSpam: true });
  });
  if (!m.threadId) m = Gmail.Users.Messages.get('me', m.id, { format: 'minimal' });
  return { subject: spec.subject, id: m.id, threadId: m.threadId };
}

/**
 * Imports a set of the checklist's synthetic mail ("Synthetic mail"). `args`:
 *
 * - `set`: `direct` (12, 3 days old), `history` (number `n`, now), `manual`
 *   (30 archive-kind, one excluded, one for `Jev/Error`; 3 days old), `bulk`
 *   (`from`–`to` of 320, 3 days old) or `live` (number `n`, now).
 * - `tag`: the run tag put at the end of every subject.
 * - For `live`: `kind` (`label` or `archive`), `daysAgo`, `excluded`.
 */
function s155_import(args) {
  args = args || {};
  var set = args.set || 'live';
  var tag = ' [' + (args.tag || 'r1') + ']';
  var specs = [];
  var n;
  if (set === 'direct') {
    for (n = 1; n <= 12; n++) {
      specs.push({ sender: 'smoke-direct', subject: 'JevSmoke direct ' + s155_pad_(n, 2) + tag, body: s155_K.labelBody, daysAgo: 3, latin1: n === 12 });
    }
  } else if (set === 'history') {
    specs.push({ sender: 'smoke-direct', subject: 'JevSmoke history ' + s155_pad_(args.n || 1, 2) + tag, body: s155_K.labelBody, daysAgo: 0 });
  } else if (set === 'manual') {
    for (n = 1; n <= 30; n++) {
      specs.push({ sender: 'smoke-manual', subject: 'JevSmoke manual ' + s155_pad_(n, 2) + tag, body: s155_K.archiveBody, daysAgo: 3 });
    }
    specs.push({ sender: 'smoke-manual', subject: 'JevSmoke manual JevSmokeExcluded' + tag, body: s155_K.archiveBody, daysAgo: 3 });
    specs.push({ sender: 'smoke-manual', subject: 'JevSmoke manual error' + tag, body: s155_K.labelBody, daysAgo: 3 });
  } else if (set === 'bulk') {
    for (n = args.from || 1; n <= Math.min(args.to || 100, 320); n++) {
      specs.push({ sender: 'smoke-bulk', subject: 'JevSmoke bulk ' + s155_pad_(n, 3) + tag, body: s155_K.labelBody, daysAgo: 3 });
    }
  } else if (set === 'live') {
    specs.push({
      sender: 'smoke-live',
      subject: 'JevSmoke live ' + s155_pad_(args.n || 1, 2) + (args.excluded ? ' JevSmokeExcluded' : '') + tag,
      body: args.kind === 'archive' ? s155_K.archiveBody : s155_K.labelBody,
      daysAgo: args.daysAgo || 0
    });
  } else {
    return s155_out_({ refused: 'set is direct, history, manual, bulk or live' });
  }
  var started = Date.now();
  var address = s155_address_();
  var imported = [];
  var stoppedAt = null;
  for (var i = 0; i < specs.length; i++) {
    if (Date.now() - started > s155_K.softLimitMs) {
      stoppedAt = specs[i].subject;
      break;
    }
    imported.push(s155_importOne_(address, specs[i]));
  }
  return s155_out_({
    set: set,
    asked: specs.length,
    imported: imported.length,
    stoppedAt: stoppedAt,
    at: Date.now(),
    ms: Date.now() - started,
    messages: imported.length <= 15 ? imported : undefined
  });
}

function s155_labelNames_() {
  var names = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(function (label) { names[label.id] = label.name; });
  return names;
}

function s155_header_(message, name) {
  var headers = (message.payload && message.payload.headers) || [];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name).toLowerCase() === name.toLowerCase()) return headers[i].value;
  }
  return undefined;
}

/** A synthetic message, or one of the classifier's own emails: the only mail this file describes. */
function s155_ours_(message, address) {
  var from = String(s155_header_(message, 'From') || '');
  var subject = String(s155_header_(message, 'Subject') || '');
  if (from.indexOf('@' + s155_K.domain) >= 0) return true;
  return from.toLowerCase().indexOf(address.toLowerCase()) >= 0 && subject.indexOf(s155_K.alertPrefix) === 0;
}

function s155_listAll_(kind, q, includeSpamTrash, limit) {
  var ids = [];
  var token;
  do {
    var options = { q: q, includeSpamTrash: includeSpamTrash, maxResults: 500 };
    if (token) options.pageToken = token;
    var page = s155_retry_(function () {
      return kind === 'threads' ? Gmail.Users.Threads.list('me', options) : Gmail.Users.Messages.list('me', options);
    });
    (page[kind] || []).forEach(function (item) { ids.push(item.id); });
    token = page.nextPageToken;
  } while (token && (!limit || ids.length < limit));
  return ids;
}

function s155_describeThread_(id, names, address) {
  var thread = Gmail.Users.Threads.get('me', id, { format: 'metadata', metadataHeaders: ['From', 'Subject'] });
  var messages = thread.messages || [];
  var ours = messages.length > 0 && messages.every(function (m) { return s155_ours_(m, address); });
  var out = { id: id, messages: messages.length, ours: ours };
  out.labels = messages.map(function (m) {
    return (m.labelIds || []).map(function (labelId) { return names[labelId] || labelId; }).sort();
  });
  if (ours) {
    out.subject = s155_header_(messages[0], 'Subject');
    out.internalDates = messages.map(function (m) { return Number(m.internalDate); });
    out.messageIds = messages.map(function (m) { return m.id; });
  }
  return out;
}

/**
 * Finds synthetic threads and the classifier's own emails. `args.q` narrows
 * the search (it is always restricted to those two kinds). `args.detail`:
 * subjects and labels of up to `args.max` (40) threads. Spam and Trash are
 * searched too unless `args.anywhere` is `false`.
 */
function s155_find(args) {
  args = args || {};
  var q = '(' + (args.q || 'subject:' + s155_K.subject) + ') (from:' + s155_K.domain + ' OR subject:"Jev Gmail Classifier")';
  var ids = s155_listAll_('threads', q, args.anywhere !== false);
  var out = { count: ids.length };
  if (args.detail) {
    var names = s155_labelNames_();
    var address = s155_address_();
    out.threads = ids.slice(0, args.max || 40).map(function (id) { return s155_describeThread_(id, names, address); });
    var summary = {};
    out.threads.forEach(function (t) { s155_count_(summary, t.labels.map(function (l) { return l.join(','); }).join(' | ')); });
    out.labelSummary = summary;
  }
  return s155_out_(out);
}

/** The label summary of every thread matching `args.q` (synthetic or the classifier's own): how many threads have which labels. */
function s155_labelCounts(args) {
  args = args || {};
  var q = '(' + (args.q || 'subject:' + s155_K.subject) + ') (from:' + s155_K.domain + ' OR subject:"Jev Gmail Classifier")';
  var ids = s155_listAll_('threads', q, true);
  var names = s155_labelNames_();
  var summary = {};
  var started = Date.now();
  var read = 0;
  for (var i = 0; i < ids.length && Date.now() - started < s155_K.softLimitMs; i++) {
    var thread = s155_retry_(function () { return Gmail.Users.Threads.get('me', ids[i], { format: 'minimal' }); });
    var labels = {};
    (thread.messages || []).forEach(function (m) {
      (m.labelIds || []).forEach(function (labelId) { labels[names[labelId] || labelId] = true; });
    });
    s155_count_(summary, Object.keys(labels).sort().join(','));
    read += 1;
  }
  return s155_out_({ count: ids.length, read: read, labelSummary: summary });
}

/**
 * The threads that hold a message from `example.test` **and** a message from
 * someone else (for check S3: a search matches a thread when any message
 * matches, so `excludeQuery` matches these). For each: how many messages, how
 * many are from `example.test`, how many the account sent, and the subject
 * when it starts with `JevSmoke`.
 */
function s155_mixed() {
  var address = s155_address_().toLowerCase();
  var ids = s155_listAll_('threads', 'from:' + s155_K.domain, true);
  var mixed = [];
  ids.forEach(function (id) {
    var thread = s155_retry_(function () { return Gmail.Users.Threads.get('me', id, { format: 'metadata', metadataHeaders: ['From', 'Subject'] }); });
    var messages = thread.messages || [];
    var synthetic = messages.filter(function (m) { return String(s155_header_(m, 'From')).indexOf('@' + s155_K.domain) >= 0; }).length;
    if (synthetic === messages.length) return;
    var own = messages.filter(function (m) { return String(s155_header_(m, 'From')).toLowerCase().indexOf(address) >= 0; }).length;
    var subject = String(s155_header_(messages[0], 'Subject') || '');
    mixed.push({ messages: messages.length, fromExampleTest: synthetic, fromTheAccount: own, subject: subject.indexOf(s155_K.subject) === 0 ? subject : '(not a JevSmoke thread)' });
  });
  return s155_out_({ threadsFromExampleTest: ids.length, mixed: mixed });
}

/** One thread's labels, by ID or by exact subject (`{subject}`). */
function s155_thread(arg) {
  var address = s155_address_();
  var id = typeof arg === 'string' ? arg : s155_threadId_(arg && arg.subject);
  if (!id) return s155_out_({ found: false });
  return s155_out_(s155_describeThread_(id, s155_labelNames_(), address));
}

/** The ID of the synthetic thread with exactly this subject, Spam and Trash included. */
function s155_threadId_(subject) {
  var ids = s155_listAll_('threads', 'subject:"' + subject + '" from:' + s155_K.domain, true);
  for (var i = 0; i < ids.length; i++) {
    var thread = Gmail.Users.Threads.get('me', ids[i], { format: 'metadata', metadataHeaders: ['Subject'] });
    if (s155_header_(thread.messages[0], 'Subject') === subject) return ids[i];
  }
  return undefined;
}

function s155_ownLabel_(name) {
  return name === 'Jev' || name === 'Jev/Error' || s155_smokeLabel_(name);
}

/** A label of the smoke test: `JevSmoke` or under it, in any case (check L5 makes `jevsmoke / a / b`). */
function s155_smokeLabel_(name) {
  return /^jevsmoke(\s*\/|$)/i.test(name);
}

/**
 * Labels named `JevSmoke…`, `Jev` or `Jev/Error` only.
 *
 * - `list`: those that exist.
 * - `create`, name: the label and its missing ancestors, top-down.
 * - `delete`, name.
 * - `add` / `remove`, name, `{threadId}` or `{subject}`: on a synthetic thread.
 */
function s155_label(action, name, target) {
  var labels = Gmail.Users.Labels.list('me').labels || [];
  var byName = {};
  labels.forEach(function (label) { byName[label.name] = label.id; });
  var result = { action: action || 'list', name: name };
  if (!action || action === 'list') {
    result.labels = labels.filter(function (l) { return s155_ownLabel_(l.name); }).map(function (l) { return { id: l.id, name: l.name }; });
    return s155_out_(result);
  }
  if (!s155_ownLabel_(String(name))) return s155_out_({ refused: 'only JevSmoke…, Jev and Jev/Error' });
  if (action === 'create') {
    var parts = name.split('/');
    result.created = [];
    for (var i = 1; i <= parts.length; i++) {
      var path = parts.slice(0, i).join('/');
      if (byName[path]) continue;
      byName[path] = Gmail.Users.Labels.create({ name: path }, 'me').id;
      result.created.push(path);
    }
    result.id = byName[name];
  } else if (action === 'delete') {
    result.existed = Boolean(byName[name]);
    if (byName[name]) Gmail.Users.Labels.remove('me', byName[name]);
  } else if (action === 'add' || action === 'remove') {
    var address = s155_address_();
    var threadId = (target && target.threadId) || s155_threadId_(target && target.subject);
    if (!threadId || !byName[name]) return s155_out_({ refused: 'no such thread or label' });
    var before = s155_describeThread_(threadId, s155_labelNames_(), address);
    if (!before.ours) return s155_out_({ refused: 'not a synthetic thread' });
    var change = action === 'add' ? { addLabelIds: [byName[name]] } : { removeLabelIds: [byName[name]] };
    Gmail.Users.Threads.modify(change, 'me', threadId);
    result.thread = s155_describeThread_(threadId, s155_labelNames_(), address);
  } else {
    result.refused = 'action is list, create, delete, add or remove';
  }
  return s155_out_(result);
}

/**
 * Which label names Gmail takes as the same label (after check L5, #155).
 * With `base` created first, it tries to create each of `variants` and says
 * whether Gmail made it or refused it. It deletes everything it created.
 * Every name must start with `JevSmoke`, in any case.
 */
function s155_labelProbe(base, variants) {
  base = base || 'JevSmokeProbe/A/B';
  variants = variants || ['jevsmokeprobe/a/b', 'JevSmokeProbe / A / B', 'JevSmokeProbe/A /B', 'JevSmokeProbe/A/ B', 'JevSmokeProbe /A/B', 'JevSmokeProbe/ A/B'];
  var names = [base].concat(variants);
  if (!names.every(function (n) { return /^jevsmoke/i.test(String(n)); })) return s155_out_({ refused: 'every name starts with JevSmoke' });
  var created = [];
  var out = { base: base, variants: {} };
  var make = function (name) {
    try {
      var label = Gmail.Users.Labels.create({ name: name }, 'me');
      created.push(label.id);
      return { created: true, storedAs: label.name };
    } catch (e) {
      return { created: false, message: String(e && e.message) };
    }
  };
  try {
    out.baseResult = make(base);
    variants.forEach(function (name) { out.variants[name] = make(name); });
  } finally {
    created.forEach(function (id) { Gmail.Users.Labels.remove('me', id); });
  }
  out.deleted = created.length;
  return s155_out_(out);
}

/**
 * The other direction of `s155_labelProbe` (for #329): the mailbox holds the
 * spaced label, and the clean name is created. Each case has its own base
 * name, so no case affects another. A case creates its `existing` names in
 * order, then tries each name in `create`, and every step's answer is kept:
 * created (with the name as Gmail stored it) or refused (Gmail's text).
 * Every name must hold `JevSmokeProbe`. It deletes everything it created, and
 * any `JevSmokeProbe` label left by an earlier run, and gives the label count
 * before and after.
 */
function s155_labelProbe2(cases) {
  var P = 'JevSmokeProbe';
  cases = cases || [
    { id: '1', existing: [P + 'P1 /A'], create: [P + 'P1/A'] },
    { id: '2a', existing: [P + 'P2 / A'], create: [P + 'P2/A'] },
    { id: '2b', existing: [P + 'P3 / A'], create: [P + 'P3/ A'] },
    { id: '2c', existing: [P + 'P4/ A'], create: [P + 'P4 / A'] },
    { id: '3a', existing: [P + 'P5/ A'], create: [P + 'P5/A'] },
    { id: '3b', existing: [P + 'P6/A '], create: [P + 'P6/A'] },
    { id: '4a', existing: [P + 'P7 ', P + 'P7 /A'], create: [P + 'P7/A'] },
    { id: '4b', existing: [P + 'P8', P + 'P8/A'], create: [P + 'P8 /A'] },
    { id: '5a', existing: [P + 'P9a/A'], create: [P + 'P9a/  A'] },
    { id: '5b', existing: [P + 'P9b/A'], create: [' ' + P + 'P9b/A'] },
    { id: '5c', existing: [P + 'P9c/A'], create: [P + 'P9c/A  '] },
    { id: '5d', existing: [P + 'P9d/A'], create: [P + 'P9d/\tA'] }
  ];
  var isProbe = function (name) { return /jevsmokeprobe/i.test(String(name)); };
  var ok = cases.every(function (c) { return (c.existing || []).concat(c.create || []).every(isProbe); });
  if (!ok) return s155_out_({ refused: 'every name holds JevSmokeProbe' });
  var list = function () { return Gmail.Users.Labels.list('me').labels || []; };
  var before = list();
  var leftovers = before.filter(function (l) { return isProbe(l.name); });
  leftovers.forEach(function (l) { Gmail.Users.Labels.remove('me', l.id); });
  var created = [];
  var make = function (name) {
    try {
      var label = Gmail.Users.Labels.create({ name: name }, 'me');
      created.push(label.id);
      return { asked: name, created: true, storedAs: label.name, storedExactly: label.name === name };
    } catch (e) {
      return { asked: name, created: false, message: String(e && e.message) };
    }
  };
  var out = { labelsBefore: before.length, leftoversDeleted: leftovers.map(function (l) { return l.name; }), cases: {} };
  try {
    cases.forEach(function (c) {
      out.cases[c.id] = { existing: (c.existing || []).map(make), create: (c.create || []).map(make) };
    });
  } finally {
    var failed = [];
    created.forEach(function (id) {
      try {
        Gmail.Users.Labels.remove('me', id);
      } catch (e) {
        failed.push(String(e && e.message));
      }
    });
    out.deleted = created.length - failed.length;
    out.deleteFailures = failed;
  }
  var after = list();
  out.labelsAfter = after.length;
  out.probeLabelsLeft = after.filter(function (l) { return isProbe(l.name); }).map(function (l) { return l.name; });
  out.sameLabelsAsBefore =
    JSON.stringify(after.map(function (l) { return l.id; }).sort()) ===
    JSON.stringify(before.filter(function (l) { return !isProbe(l.name); }).map(function (l) { return l.id; }).sort());
  return s155_out_(out);
}

function s155_textParts_(part, out) {
  out = out || { types: [], filenames: [], text: null };
  out.types.push(part.mimeType);
  if (part.filename) out.filenames.push(part.filename);
  if (part.mimeType === 'text/plain' && out.text === null && part.body && part.body.data) {
    out.text = Utilities.newBlob(part.body.data).getDataAsString('UTF-8');
  }
  (part.parts || []).forEach(function (child) { s155_textParts_(child, out); });
  return out;
}

function s155_describeAlert_(message, names) {
  var parts = s155_textParts_(message.payload);
  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: Number(message.internalDate),
    from: s155_header_(message, 'From'),
    to: s155_header_(message, 'To'),
    subject: s155_header_(message, 'Subject'),
    contentType: s155_header_(message, 'Content-Type'),
    labels: (message.labelIds || []).map(function (labelId) { return names[labelId] || labelId; }).sort(),
    mimeTypes: parts.types,
    filenames: parts.filenames,
    bodyChars: parts.text === null ? null : parts.text.length,
    body: parts.text
  };
}

/**
 * The classifier's own emails: subject `[Jev Gmail Classifier] …`, sent by
 * the account itself. `args.since` (epoch ms) keeps the newer ones;
 * `args.bodies: false` leaves the bodies out.
 */
function s155_alerts(args) {
  args = args || {};
  var address = s155_address_();
  var names = s155_labelNames_();
  var ids = s155_listAll_('messages', 'subject:"Jev Gmail Classifier"', true);
  var alerts = [];
  ids.forEach(function (id) {
    var message = Gmail.Users.Messages.get('me', id, { format: 'full' });
    if (!s155_ours_(message, address)) return;
    if (args.since && Number(message.internalDate) < args.since) return;
    var alert = s155_describeAlert_(message, names);
    if (args.bodies === false) delete alert.body;
    alerts.push(alert);
  });
  alerts.sort(function (a, b) { return a.internalDate - b.internalDate; });
  return s155_out_({ count: alerts.length, alerts: alerts });
}

/**
 * Prepares checks N13 and N14 for the person who opens the links: puts the
 * label `Jev/Error` on one synthetic thread, and sends the account an email
 * with the two Gmail links, built the way the `Jev/Error` alert builds them
 * (`src/core/alert-email.ts`). The links hold the account's address, so they
 * are only ever in that email, never in what this function returns.
 */
function s155_linksEmail(args) {
  args = args || {};
  var address = s155_address_();
  var subject = args.subject || 'JevSmoke direct 05 [' + (args.tag || 'r1') + ']';
  var threadId = s155_threadId_(subject);
  if (!threadId) return s155_out_({ sent: false, refused: 'no such synthetic thread' });
  var labels = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) { labels[l.name] = l.id; });
  var created = [];
  ['Jev', 'Jev/Error'].forEach(function (name) {
    if (labels[name]) return;
    labels[name] = Gmail.Users.Labels.create({ name: name }, 'me').id;
    created.push(name);
  });
  Gmail.Users.Threads.modify({ addLabelIds: [labels['Jev/Error']] }, 'me', threadId);
  var base = 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(address);
  var body = [
    'Smoke test (#155): two links to open, built the way the Jev/Error alert email builds them.',
    '',
    '1. This link should open the thread "' + subject + '", in this account:',
    base + '#all/' + encodeURIComponent(threadId),
    '',
    '2. This link should list that same thread under the label Jev/Error, in this account:',
    'All threads with the label: ' + base + '#label/' + encodeURIComponent('Jev/Error'),
    '',
    'This email was sent by the smoke-test helper (spikes/155-smoke.js), not by the classifier.'
  ].join('\n');
  var result = new (s155_adapters_().GasMailAdapter)().send(address, s155_K.alertPrefix + ' Smoke test links', body);
  return s155_out_({ sent: result, thread: subject, labelsCreated: created, jevErrorLabelId: labels['Jev/Error'], threadLabels: s155_threadLabels_(threadId) });
}

/**
 * Moves synthetic threads (`what: 'synthetic'`) or the classifier's own
 * emails (`what: 'alerts'`) to Trash. `args.q` narrows it.
 */
function s155_trash(args) {
  args = args || {};
  var address = s155_address_();
  var base = args.what === 'alerts' ? 'subject:"Jev Gmail Classifier" from:me' : 'from:' + s155_K.domain + ' subject:' + s155_K.subject;
  var ids = s155_listAll_('threads', '(' + base + ')' + (args.q ? ' (' + args.q + ')' : '') + ' -in:trash', false);
  var started = Date.now();
  var trashed = 0;
  var skipped = 0;
  for (var i = 0; i < ids.length && Date.now() - started < s155_K.softLimitMs; i++) {
    var thread = Gmail.Users.Threads.get('me', ids[i], { format: 'metadata', metadataHeaders: ['From', 'Subject'] });
    if (!(thread.messages || []).every(function (m) { return s155_ours_(m, address); })) {
      skipped += 1;
      continue;
    }
    s155_retry_(function () { return Gmail.Users.Threads.trash('me', ids[i]); });
    trashed += 1;
  }
  return s155_out_({ found: ids.length, trashed: trashed, skipped: skipped, left: ids.length - trashed - skipped });
}

// ---------------------------------------------------------------- direct adapter checks

/** The lock sleeper (section K): takes the lock, sleeps, releases. */
function s155_sleeper(ms) {
  var lock = new (s155_adapters_().GasLockAdapter)();
  var started = Date.now();
  var got = lock.tryAcquire();
  Utilities.sleep(typeof ms === 'number' ? ms : 60000);
  lock.release();
  return s155_out_({ tryAcquire: got, started: started, ended: Date.now() });
}

/** Polls `fn` until it returns something truthy, for up to `seconds`. */
function s155_wait_(fn, seconds) {
  var end = Date.now() + (seconds || 30) * 1000;
  for (;;) {
    var value = fn();
    if (value || Date.now() > end) return value;
    Utilities.sleep(1500);
  }
}

function s155_jevRequest_(headers) {
  return {
    url: 'https://api.typesafe.ai/v1/systemone',
    method: 'post',
    headers: headers || {},
    contentType: 'application/json',
    payload: JSON.stringify({
      model: 'jev-latest',
      state: [{ subject: 'JevSmoke', body: 'JevSmokeBody. A synthetic message.' }],
      questions: { q1: { type: 'noul', instructions: 'Is this a synthetic message?' } }
    })
  };
}

/**
 * Runs the direct checks of one section, or one check: `G`, `T`, `L`,
 * `deleted` (T12 and L15, with `args.threadId` and `args.labelId`), `U`,
 * `H`, `K1`, `K2`, `K3` (run it while the sleeper sleeps; it covers K3 and
 * the first half of K4), `K5` (it throws on purpose), `K7`, `K8`, `A`, `M`,
 * `Mflowed` (M6 with long lines), `S3`, `R5`, `C`, `P`. `args.tag` is the run tag of the synthetic mail.
 * Each check's value is what the adapter returned, cut down to what the
 * checklist compares, or `{threw}`.
 */
function s155_check(id, args) {
  args = args || {};
  var groups = {
    G: s155_checkG_, T: s155_checkT_, L: s155_checkL_, deleted: s155_checkDeleted_, L5: s155_checkL5_, U: s155_checkU_, H: s155_checkH_,
    K1: s155_checkK_, K2: s155_checkK_, K3: s155_checkK_, K5: s155_checkK_, K7: s155_checkK_, K8: s155_checkK_,
    A: s155_checkA_, M: s155_checkM_, Mflowed: s155_checkMflowed_, S3: s155_checkS3_, R5: s155_checkR5_, C: s155_checkC_, P: s155_checkP_
  };
  if (!groups[id]) return s155_out_({ refused: 'id is one of: ' + Object.keys(groups).join(', ') });
  var tag = ' [' + (args.tag || 'r1') + ']';
  var started = Date.now();
  var checks = groups[id](s155_adapters_(), tag, args, id);
  return s155_out_({ section: id, ms: Date.now() - started, checks: checks });
}

function s155_checkG_(A, tag) {
  var gmail = new A.GasGmailAdapter();
  var address = s155_address_();
  var types = ['messageAdded'];
  var out = {};
  var deliver = function (n) {
    return s155_importOne_(address, { sender: 'smoke-direct', subject: 'JevSmoke history ' + s155_pad_(n, 2) + tag, body: s155_K.labelBody, daysAgo: 0 });
  };
  var addedIds = function (records) {
    var ids = [];
    records.forEach(function (r) { (r.messagesAdded || []).forEach(function (a) { ids.push(a.message.id); }); });
    return ids;
  };
  var profile = gmail.getProfile();
  out.G1 = { ok: profile.ok, emailAddress: profile.emailAddress, historyId: profile.historyId, historyIdIsDigits: /^\d+$/.test(String(profile.historyId)) };

  out.G2 = s155_try_(function () {
    var m = deliver(1);
    var r = s155_wait_(function () {
      var page = gmail.listHistory({ startHistoryId: profile.historyId, historyTypes: types });
      return page.ok && addedIds(page.records).indexOf(m.id) >= 0 ? page : null;
    }, 20) || gmail.listHistory({ startHistoryId: profile.historyId, historyTypes: types });
    var record = (r.records || []).filter(function (rec) { return rec.messagesAdded && rec.messagesAdded[0] && rec.messagesAdded[0].message.id === m.id; })[0];
    return {
      ok: r.ok, historyIdIsDigits: /^\d+$/.test(String(r.historyId)), records: (r.records || []).length,
      hasRecordForMessage: Boolean(record), recordKeys: record ? Object.keys(record).sort() : null,
      messageKeys: record ? Object.keys(record.messagesAdded[0].message).sort() : null, hasNextPageToken: 'nextPageToken' in r
    };
  });

  var first;
  out.G3 = s155_try_(function () {
    var m2 = deliver(2);
    var m3 = deliver(3);
    s155_wait_(function () {
      var page = gmail.listHistory({ startHistoryId: profile.historyId, historyTypes: types });
      var ids = page.ok ? addedIds(page.records) : [];
      return ids.indexOf(m2.id) >= 0 && ids.indexOf(m3.id) >= 0;
    }, 20);
    first = gmail.listHistory({ startHistoryId: profile.historyId, historyTypes: types, maxResults: 1 });
    return { ok: first.ok, records: (first.records || []).length, hasNextPageToken: typeof first.nextPageToken === 'string' };
  });

  var pageIds = [];
  out.G4 = s155_try_(function () {
    var pages = [];
    var page = first;
    pageIds.push(page.records[0].id);
    while (page.nextPageToken && pages.length < 50) {
      page = gmail.listHistory({ startHistoryId: profile.historyId, historyTypes: types, maxResults: 1, pageToken: page.nextPageToken });
      pages.push({ ok: page.ok, records: (page.records || []).length, hasNextPageToken: 'nextPageToken' in page });
      (page.records || []).forEach(function (rec) { pageIds.push(rec.id); });
    }
    var distinct = pageIds.filter(function (v, i) { return pageIds.indexOf(v) === i; }).length;
    return { pagesAfterTheFirst: pages, recordsInAll: pageIds.length, distinctRecords: distinct, lastPageHasTokenKey: 'nextPageToken' in page };
  });

  out.G5 = s155_try_(function () {
    var r = gmail.listHistory({ startHistoryId: pageIds[0], historyTypes: types });
    var ids = (r.records || []).map(function (rec) { return rec.id; });
    return {
      ok: r.ok, records: ids.length, includesTheStartRecord: ids.indexOf(pageIds[0]) >= 0,
      sameAsTheLaterPages: JSON.stringify(ids) === JSON.stringify(pageIds.slice(1)),
      allIdsGreater: ids.every(function (v) { return Number(v) > Number(pageIds[0]); })
    };
  });

  out.G6 = s155_try_(function () { return gmail.listHistory({ startHistoryId: '1', historyTypes: types }); });

  out.G7 = s155_try_(function () {
    var p = gmail.getProfile();
    var r = gmail.listHistory({ startHistoryId: p.historyId, historyTypes: types });
    return { ok: r.ok, records: r.records, hasNextPageToken: 'nextPageToken' in r };
  });
  return out;
}

function s155_checkT_(A, tag) {
  var gmail = new A.GasGmailAdapter();
  var out = {};
  var subject = function (n) { return 'JevSmoke direct ' + s155_pad_(n, 2) + tag; };
  var id01 = s155_threadId_(subject(1));
  var id04 = s155_threadId_(subject(4));

  var t1;
  out.T1 = s155_try_(function () {
    t1 = gmail.searchThreadIds({ q: 'in:inbox', includeSpamTrash: false, maxResults: 2 });
    return { ok: t1.ok, threadIds: (t1.threadIds || []).length, hasNextPageToken: typeof t1.nextPageToken === 'string' };
  });
  out.T2 = s155_try_(function () {
    var t2 = gmail.searchThreadIds({ q: 'in:inbox', includeSpamTrash: false, maxResults: 2, pageToken: t1.nextPageToken });
    return { ok: t2.ok, threadIds: (t2.threadIds || []).length, repeatsAnId: (t2.threadIds || []).some(function (v) { return t1.threadIds.indexOf(v) >= 0; }) };
  });
  out.T3 = s155_try_(function () {
    var q = 'from:smoke-direct@' + s155_K.domain;
    var page = gmail.searchThreadIds({ q: q, includeSpamTrash: false, maxResults: 5 });
    var pages = 1;
    var ids = page.threadIds.slice();
    while (page.nextPageToken && pages < 50) {
      page = gmail.searchThreadIds({ q: q, includeSpamTrash: false, maxResults: 5, pageToken: page.nextPageToken });
      pages += 1;
      ids = ids.concat(page.threadIds);
    }
    return {
      q: q, pages: pages, threadIds: ids.length, distinct: ids.filter(function (v, i) { return ids.indexOf(v) === i; }).length,
      lastPageKeys: Object.keys(page).sort(), lastPageHasTokenKey: 'nextPageToken' in page
    };
  });
  out.T4 = s155_try_(function () {
    var r = gmail.searchThreadIds({ q: 'in:inbox', includeSpamTrash: false });
    return { ok: r.ok, keys: Object.keys(r).sort(), threadIds: r.threadIds.length, everyIdIsAString: r.threadIds.every(function (v) { return typeof v === 'string'; }) };
  });
  out.T5 = s155_try_(function () {
    var r = gmail.searchThreadIds({ q: 'subject:jev-smoke-no-such-subject-91f3', includeSpamTrash: false });
    return { ok: r.ok, threadIds: r.threadIds, keys: Object.keys(r).sort() };
  });
  out.T6 = s155_try_(function () {
    Gmail.Users.Threads.trash('me', id04);
    var q = 'subject:"' + subject(4) + '"';
    var r = s155_wait_(function () {
      var page = gmail.searchThreadIds({ q: q, includeSpamTrash: false });
      return page.threadIds.indexOf(id04) < 0 ? page : null;
    }, 20) || gmail.searchThreadIds({ q: q, includeSpamTrash: false });
    return { ok: r.ok, threadIds: r.threadIds.length, includesTheTrashedThread: r.threadIds.indexOf(id04) >= 0 };
  });
  out.T7 = s155_try_(function () {
    var r = gmail.searchThreadIds({ q: 'subject:"' + subject(4) + '"', includeSpamTrash: true });
    return { ok: r.ok, threadIds: r.threadIds.length, includesTheTrashedThread: r.threadIds.indexOf(id04) >= 0 };
  });
  out.T8 = s155_try_(function () {
    var r = gmail.getThread(id01, { format: 'metadata', metadataHeaders: ['Date'] });
    return {
      ok: r.ok, messages: r.thread.messages.length,
      each: r.thread.messages.map(function (m) {
        return {
          hasId: typeof m.id === 'string', labelIds: m.labelIds, internalDateType: typeof m.internalDate,
          headerNames: ((m.payload && m.payload.headers) || []).map(function (h) { return h.name; }),
          hasBodyData: JSON.stringify(m.payload || {}).indexOf('"data"') >= 0
        };
      })
    };
  });
  out.T9 = s155_try_(function () {
    var r = gmail.getThread(id01, { format: 'full' });
    return {
      ok: r.ok,
      each: r.thread.messages.map(function (m) {
        var data = m.payload.body && m.payload.body.data;
        return {
          mimeType: m.payload.mimeType, dataIsArray: Array.isArray(data), dataType: typeof data,
          elementsAreNumbers: Array.isArray(data) && data.every(function (b) { return typeof b === 'number' && b >= -128 && b <= 127; }),
          dataLength: data ? data.length : null, internalDateType: typeof m.internalDate
        };
      })
    };
  });
  out.T10 = s155_try_(function () {
    var r = gmail.getThread(id01, { format: 'minimal' });
    return { ok: r.ok, each: r.thread.messages.map(function (m) { return { keys: Object.keys(m).sort(), hasPayload: 'payload' in m }; }) };
  });
  out.T11 = s155_try_(function () {
    var r = gmail.getThread(id04, { format: 'minimal' });
    return { ok: r.ok, messages: r.thread.messages.length, labelIds: r.thread.messages.map(function (m) { return m.labelIds; }) };
  });
  out.T13 = s155_try_(function () { return gmail.getThread('not-a-thread-id', { format: 'minimal' }); });
  out.T15 = s155_try_(function () { return gmail.searchThreadIds({ q: 'in:inbox', includeSpamTrash: false, pageToken: 'not-a-token' }); });
  return out;
}

function s155_threadLabels_(threadId) {
  var thread = Gmail.Users.Threads.get('me', threadId, { format: 'minimal' });
  return (thread.messages || []).map(function (m) { return (m.labelIds || []).slice().sort(); });
}

function s155_checkL_(A, tag) {
  var gmail = new A.GasGmailAdapter();
  var out = {};
  var tid = function (n) { return s155_threadId_('JevSmoke direct ' + s155_pad_(n, 2) + tag); };
  var smokeNames = function (labels) {
    return labels.filter(function (l) { return s155_smokeLabel_(l.name); }).map(function (l) { return l.name; }).sort();
  };
  var labelId;

  out.L1 = s155_try_(function () {
    var r = gmail.listLabels();
    var user = r.labels.filter(function (l) { return !/^[A-Z_]+$/.test(l.id); });
    return {
      ok: r.ok, keys: Object.keys(r).sort(), labels: r.labels.length,
      everyLabelHasIdAndName: r.labels.every(function (l) { return typeof l.id === 'string' && typeof l.name === 'string'; }),
      hasInboxAndSpam: ['INBOX', 'SPAM'].every(function (v) { return r.labels.some(function (l) { return l.id === v; }); }),
      userLabels: user.length, userIdsMatch: user.every(function (l) { return /^Label_\d+$/.test(l.id); }),
      jevSmokeLabelsBefore: smokeNames(r.labels)
    };
  });
  out.L2 = s155_try_(function () {
    var r = gmail.createLabel('JevSmoke/A/B');
    if (r.ok) labelId = r.label.id;
    return r.ok ? { ok: true, idMatches: /^Label_\d+$/.test(r.label.id), name: r.label.name } : r;
  });
  out.L3 = s155_try_(function () { return { jevSmokeLabels: smokeNames(gmail.listLabels().labels) }; });
  out.L4 = s155_try_(function () { return gmail.createLabel('JevSmoke/A/B'); });
  out.L5 = s155_try_(function () { return gmail.createLabel('jevsmoke / a / b'); });
  out.L6 = s155_try_(function () { return gmail.createLabel('Inbox'); });

  var t2 = tid(2);
  var after7;
  out.L7 = s155_try_(function () {
    var before = s155_threadLabels_(t2);
    var r = gmail.modifyThread(t2, { addLabelIds: [labelId], removeLabelIds: [] });
    after7 = s155_threadLabels_(t2);
    return { result: r, before: before, after: after7, everyMessageHasTheLabel: after7.every(function (l) { return l.indexOf(labelId) >= 0; }) };
  });
  out.L8 = s155_try_(function () {
    var r = gmail.modifyThread(t2, { addLabelIds: [labelId], removeLabelIds: [] });
    return { result: r, unchanged: JSON.stringify(s155_threadLabels_(t2)) === JSON.stringify(after7) };
  });
  var t3 = tid(3);
  out.L9 = s155_try_(function () {
    var before = s155_threadLabels_(t3);
    var r = gmail.modifyThread(t3, { addLabelIds: ['JevSmoke/A/B'], removeLabelIds: [] });
    return { result: r, unchanged: JSON.stringify(s155_threadLabels_(t3)) === JSON.stringify(before) };
  });
  out.L10 = s155_try_(function () {
    var before = s155_threadLabels_(t3);
    var r = gmail.modifyThread(t3, { addLabelIds: ['Label_999999999'], removeLabelIds: [] });
    return { result: r, unchanged: JSON.stringify(s155_threadLabels_(t3)) === JSON.stringify(before) };
  });
  var move = function (n, withLabelFirst, change) {
    return s155_try_(function () {
      var id = tid(n);
      if (withLabelFirst) gmail.modifyThread(id, { addLabelIds: [labelId], removeLabelIds: [] });
      var before = s155_threadLabels_(id);
      var r = gmail.modifyThread(id, change);
      var after = s155_threadLabels_(id);
      return { result: r, before: before, after: after, hasTheUserLabel: after.every(function (l) { return l.indexOf(labelId) >= 0; }) };
    });
  };
  out.L11 = move(7, true, { addLabelIds: [], removeLabelIds: ['INBOX'] });
  out.L12 = move(8, false, { addLabelIds: [labelId], removeLabelIds: ['INBOX'] });
  out.L13 = move(9, true, { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
  out.L14 = move(10, true, { addLabelIds: ['TRASH'], removeLabelIds: [] });
  out.userLabelId = labelId;
  return out;
}

/**
 * T12 and L15, after a person has deleted a thread forever in Gmail.
 * `args.threadId` is that thread's ID, `args.labelId` an existing user label.
 */
function s155_checkDeleted_(A, tag, args) {
  var gmail = new A.GasGmailAdapter();
  if (!args.threadId || !args.labelId) return { refused: 'pass threadId and labelId' };
  return {
    T12: s155_try_(function () { return gmail.getThread(args.threadId, { format: 'minimal' }); }),
    L15: s155_try_(function () { return gmail.modifyThread(args.threadId, { addLabelIds: [args.labelId], removeLabelIds: [] }); })
  };
}

/** L5 as #329 corrected it: with `JevSmoke/A/B` in the mailbox, `createLabel('jevsmoke/a-b')`. */
function s155_checkL5_(A) {
  var gmail = new A.GasGmailAdapter();
  var before = gmail.listLabels();
  var exists = before.ok && before.labels.some(function (l) { return l.name === 'JevSmoke/A/B'; });
  var result = s155_try_(function () { return gmail.createLabel('jevsmoke/a-b'); });
  var made = result && result.ok ? result.label.id : null;
  if (made) Gmail.Users.Labels.remove('me', made);
  return { L5: { baseExists: exists, result: result, deletedWhatItMade: Boolean(made) } };
}

function s155_checkU_(A, tag) {
  var decode = A.gasDecodeUtf8;
  var codes = function (text) {
    var out = [];
    for (var i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
    return out;
  };
  var out = {};
  out.U1 = s155_try_(function () { var v = decode([]); return { value: v, isEmptyString: v === '' }; });
  out.U2 = s155_try_(function () { return { value: decode([72, 105]) }; });
  out.U3 = s155_try_(function () {
    var v = decode([-61, -87, -26, -105, -91, -16, -97, -103, -126]);
    return { value: v, length: v.length, equalsExpected: v === '\u00e9\u65e5\ud83d\ude42', codeUnits: codes(v) };
  });
  out.U4 = s155_try_(function () { var v = decode([-17, -69, -65, 65]); return { length: v.length, codeUnits: codes(v) }; });
  out.U5 = s155_try_(function () { var v = decode([-1]); return { length: v.length, codeUnits: codes(v) }; });
  out.U6 = s155_try_(function () {
    var gmail = new A.GasGmailAdapter();
    var r = gmail.getThread(s155_threadId_('JevSmoke direct 12' + tag), { format: 'full' });
    var payload = r.thread.messages[0].payload;
    var contentType = (payload.headers || []).filter(function (h) { return h.name.toLowerCase() === 'content-type'; })[0];
    var text = decode(payload.body.data);
    return {
      declared: contentType && contentType.value, endsWith: text.replace(/\s+$/, '').slice(-8), hasCafe: text.indexOf('caf\u00e9') >= 0,
      hasMojibake: text.indexOf('caf\u00c3') >= 0, hasReplacementChar: text.indexOf('\ufffd') >= 0
    };
  });
  return out;
}

function s155_checkH_(A) {
  var secrets = new A.GasSecretsAdapter();
  var http = new A.GasHttpAdapter();
  var store = PropertiesService.getScriptProperties();
  var real = store.getProperty('JEV_API_KEY');
  var out = {};
  try {
    store.deleteProperty('JEV_API_KEY');
    out.H1 = s155_try_(function () { var v = secrets.getJevApiKey(); return { isUndefined: v === undefined }; });
    store.setProperty('JEV_API_KEY', '   ');
    out.H2 = s155_try_(function () { var v = secrets.getJevApiKey(); return { isUndefined: v === undefined }; });
    store.setProperty('JEV_API_KEY', ' test-key ');
    out.H3 = s155_try_(function () { return { value: secrets.getJevApiKey() }; });
  } finally {
    if (real !== null) store.setProperty('JEV_API_KEY', real);
    else store.deleteProperty('JEV_API_KEY');
  }
  out.keyRestored = store.getProperty('JEV_API_KEY') === real && real !== null;
  var key = secrets.getJevApiKey();
  var leaks = function (text) {
    var t = String(text);
    return { bearer: t.indexOf('Bearer') >= 0, key: Boolean(key) && t.indexOf(key) >= 0, payload: t.indexOf('JevSmokeBody') >= 0 };
  };
  var headerFacts = function (headers) {
    var names = Object.keys(headers).sort();
    return { names: names, allLowerCase: names.every(function (n) { return n === n.toLowerCase(); }) };
  };

  out.H4 = s155_try_(function () { return { value: http.sendAll([]) }; });
  out.H5 = s155_try_(function () {
    var r = http.sendAll([s155_jevRequest_({})]);
    var first = r[0];
    var parsed = s155_try_(function () { return JSON.parse(first.body); });
    return {
      results: r.length, ok: first.ok, status: first.status, headers: headerFacts(first.headers),
      bodyStarts: String(first.body).slice(0, 48), errorType: parsed && parsed.detail && parsed.detail.error_type
    };
  });
  out.H6 = s155_try_(function () {
    var r = http.sendAll([s155_jevRequest_({ Authorization: 'Bearer ' + key })]);
    var first = r[0];
    var parsed = s155_try_(function () { return JSON.parse(first.body); });
    return {
      ok: first.ok, status: first.status, hasRequestId: typeof first.headers['x-typesafe-request-id'] === 'string',
      headers: headerFacts(first.headers), bodyKeys: Object.keys(parsed).sort(), inputTokens: parsed.usage && parsed.usage.input_tokens
    };
  });
  out.H7 = s155_try_(function () {
    var r = http.sendAll([
      s155_jevRequest_({ Authorization: 'Bearer ' + key }),
      { url: 'https://jev-smoke.invalid/', method: 'get', headers: {} },
      { url: 'https://www.google.com/generate_204', method: 'get', headers: {} }
    ]);
    return { results: r.map(function (x) { return { ok: x.ok, kind: x.kind, message: x.message, leaks: leaks(JSON.stringify(x)) }; }) };
  });
  out.H8 = s155_try_(function () {
    var r = http.sendAll([{ url: 'https://google.com/', method: 'get', headers: {} }]);
    return { ok: r[0].ok, status: r[0].status, location: r[0].headers.location, bodyChars: String(r[0].body).length };
  });
  return out;
}

function s155_checkK_(A, tag, args, id) {
  var lock = new A.GasLockAdapter();
  var out = {};
  if (id === 'K1') {
    out.K1 = { tryAcquire: lock.tryAcquire() };
    lock.release();
  } else if (id === 'K2') {
    out.K2 = { first: lock.tryAcquire(), second: lock.tryAcquire() };
    lock.release();
  } else if (id === 'K3') {
    var before = Date.now();
    var got = lock.tryAcquire();
    out.K3 = { tryAcquire: got, ms: Date.now() - before };
    out.K4 = { release: s155_try_(function () { lock.release(); return 'returned'; }), at: Date.now() };
  } else if (id === 'K5') {
    var took = lock.tryAcquire();
    throw new Error('s155 K5: thrown on purpose while holding the lock (tryAcquire gave ' + took + ')');
  } else if (id === 'K7') {
    out.K7 = { release: s155_try_(function () { lock.release(); return 'returned'; }) };
  } else if (id === 'K8') {
    out.K8 = {
      tryAcquire: lock.tryAcquire(),
      firstRelease: s155_try_(function () { lock.release(); return 'returned'; }),
      secondRelease: s155_try_(function () { lock.release(); return 'returned'; })
    };
  }
  return out;
}

function s155_checkA_(A) {
  var auth = new A.GasAuthAdapter();
  return {
    A1: s155_try_(function () { return auth.missingScopes(); }),
    A2: s155_try_(function () { auth.requireScopes(A.INSTALL_REQUIRED_SCOPES); return { returned: true, scopes: A.INSTALL_REQUIRED_SCOPES.length }; })
  };
}

function s155_findOwn_(subject, since, exclude) {
  var address = s155_address_();
  var ids = s155_listAll_('messages', 'subject:"' + subject + '" from:me', true);
  for (var i = 0; i < ids.length; i++) {
    if (exclude && exclude.indexOf(ids[i]) >= 0) continue;
    var message = Gmail.Users.Messages.get('me', ids[i], { format: 'full' });
    if (Number(message.internalDate) < since - 5000) continue;
    if (s155_header_(message, 'Subject') !== subject || !s155_ours_(message, address)) continue;
    return message;
  }
  return null;
}

function s155_checkM_(A) {
  var mail = new A.GasMailAdapter();
  var address = s155_address_();
  var names = s155_labelNames_();
  var out = {};
  var subject = s155_K.alertPrefix + ' Smoke test';
  var normal = function (text) { return String(text).replace(/\r\n/g, '\n').replace(/\s+$/, ''); };
  var first;

  var started = Date.now();
  out.M1 = s155_try_(function () { return mail.send(address, subject, 'Line 1\nLine 2'); });
  out.M2 = s155_try_(function () {
    first = s155_wait_(function () { return s155_findOwn_(subject, started); }, 60);
    if (!first) return { arrived: false };
    var d = s155_describeAlert_(first, names);
    return { arrived: true, from: d.from, to: d.to, subject: d.subject, body: d.body, mimeTypes: d.mimeTypes, filenames: d.filenames };
  });
  out.M3 = s155_try_(function () {
    var thread = Gmail.Users.Threads.get('me', first.threadId, { format: 'minimal' });
    return { labels: s155_describeAlert_(first, names).labels, messagesInThread: thread.messages.length, threadIdEqualsMessageId: first.threadId === first.id };
  });
  out.M4 = s155_try_(function () {
    var again = Date.now();
    var r = mail.send(address, subject, 'Line 1\nLine 2');
    var second = s155_wait_(function () { return s155_findOwn_(subject, again, [first.id]); }, 60);
    if (!second) return { result: r, arrived: false };
    var thread = Gmail.Users.Threads.get('me', second.threadId, { format: 'minimal' });
    return { result: r, arrived: true, joinedTheFirstThread: second.threadId === first.threadId, messagesInThread: thread.messages.length };
  });
  var roundTrip = function (subjectText, body) {
    return s155_try_(function () {
      var at = Date.now();
      var r = mail.send(address, subjectText, body);
      var message = s155_wait_(function () { return s155_findOwn_(subjectText, at); }, 60);
      if (!message) return { result: r, arrived: false };
      var text = s155_textParts_(message.payload).text;
      return {
        result: r, arrived: true, sentChars: body.length, receivedChars: text.length, identical: text === body,
        identicalApartFromLineEnds: normal(text) === normal(body), tail: JSON.stringify(text.slice(-4))
      };
    });
  };
  out.M5 = roundTrip(s155_K.alertPrefix + ' Smoke test 2', 'caf\u00e9 \u2026 \u65e5\u672c');
  var long = '';
  for (var i = 0; long.length < 5000; i++) long += 'Line ' + s155_pad_(i, 3) + ' of the long synthetic smoke-test body, with no real content in it.\n';
  out.M6 = roundTrip(s155_K.alertPrefix + ' Smoke test 3', long.slice(0, 5000));
  out.M7 = s155_try_(function () { return mail.send('not-an-address', 'x', 'y'); });
  out.remainingDailyQuota = s155_try_(function () { return MailApp.getRemainingDailyQuota(); });
  return out;
}

/**
 * M6 again with long lines: 5,000 characters in five paragraphs, each one
 * line. `MailApp` sends `format=flowed; delsp=yes` (RFC 3676), so a long line
 * arrives soft-wrapped: a line that ends with a space goes on in the next
 * line, and that space is not part of the text.
 */
function s155_checkMflowed_(A) {
  var mail = new A.GasMailAdapter();
  var address = s155_address_();
  var subject = s155_K.alertPrefix + ' Smoke test 4';
  var paragraph = '';
  for (var i = 0; paragraph.length < 999; i++) paragraph += 'word' + s155_pad_(i, 3) + ' ';
  paragraph = paragraph.slice(0, 999);
  var body = [paragraph, paragraph, paragraph, paragraph, paragraph].join('\n').slice(0, 5000);
  var at = Date.now();
  var result = mail.send(address, subject, body);
  var message = s155_wait_(function () { return s155_findOwn_(subject, at); }, 60);
  if (!message) return { M6: { result: result, arrived: false } };
  var text = s155_textParts_(message.payload).text;
  var lines = text.split('\r\n');
  var unflowed = '';
  lines.forEach(function (line, index) {
    var soft = line.charAt(line.length - 1) === ' ' && line !== '-- ';
    unflowed += soft ? line.slice(0, -1) : line + (index < lines.length - 1 ? '\n' : '');
  });
  return {
    M6: {
      result: result, contentType: s155_header_(message, 'Content-Type'), sentChars: body.length, sentLongestLine: 999,
      receivedChars: text.length, receivedLines: lines.length, receivedLongestLine: Math.max.apply(null, lines.map(function (l) { return l.length; })),
      identicalAfterUnflowing: unflowed.replace(/\n+$/, '') === body.replace(/\n+$/, '')
    }
  };
}

function s155_checkS3_(A, tag, args) {
  var gmail = new A.GasGmailAdapter();
  var all = function (q) {
    var ids = [];
    var token;
    do {
      var request = { q: q, includeSpamTrash: true, maxResults: 500 };
      if (token) request.pageToken = token;
      var page = gmail.searchThreadIds(request);
      if (!page.ok) throw new Error('search failed: ' + page.kind);
      ids = ids.concat(page.threadIds);
      token = page.nextPageToken;
    } while (token);
    return ids;
  };
  var a = all(args.excludeQuery || s155_K.excludeQuery);
  var b = all('from:' + s155_K.domain);
  var c = all('subject:"Jev Gmail Classifier"');
  var d = all('in:anywhere');
  var inA = {};
  var inB = {};
  var inC = {};
  a.forEach(function (id) { inA[id] = true; });
  b.forEach(function (id) { inB[id] = true; });
  c.forEach(function (id) { inC[id] = true; });
  var both = a.filter(function (id) { return inB[id]; });
  var bothMarked = both.filter(function (id) {
    var thread = Gmail.Users.Threads.get('me', id, { format: 'metadata', metadataHeaders: ['Subject'] });
    return (thread.messages || []).some(function (m) { return String(s155_header_(m, 'Subject')).indexOf('JevSmokeExcluded') >= 0; });
  });
  var uncovered = d.filter(function (id) { return !inA[id] && !inB[id] && !inC[id]; });
  var address = s155_address_();
  var cNotOurs = c.filter(function (id) {
    if (inA[id] || inB[id]) return false;
    var thread = Gmail.Users.Threads.get('me', id, { format: 'metadata', metadataHeaders: ['From', 'Subject'] });
    return !(thread.messages || []).every(function (m) { return s155_ours_(m, address); });
  });
  return {
    S3: {
      a: a.length, b: b.length, c: c.length, d: d.length,
      inBothAAndB: both.length, ofThoseMarkedExcluded: bothMarked.length,
      inDButInNone: uncovered.length,
      sendableNotSynthetic: c.filter(function (id) { return !inA[id] && !inB[id]; }).length,
      sendableNotSyntheticAndNotTheClassifiersOwn: cNotOurs.length
    }
  };
}

function s155_checkR5_(A) {
  var trigger = new A.GasTriggerAdapter();
  var out = {};
  out.R5 = {
    replace: s155_try_(function () { return trigger.replaceRecurringTrigger('onTrigger', 10); }),
    triggersBetween: s155_triggers_().filter(function (t) { return t.handler === 'onTrigger'; }).length,
    remove: s155_try_(function () { return trigger.deleteTriggers('onTrigger'); }),
    triggersAfter: s155_triggers_()
  };
  return out;
}

function s155_checkC_(A) {
  var out = {};
  out.C7 = s155_try_(function () {
    var before = Date.now();
    var now = new A.GasClockAdapter().now();
    var after = Date.now();
    return { before: before, now: now, after: after, isInteger: Number.isInteger(now), inOrder: before <= now && now <= after };
  });
  out.C9 = s155_try_(function () {
    var clock = new A.GasClockAdapter();
    var start = clock.now();
    clock.sleep(1500);
    return { elapsed: clock.now() - start };
  });
  out.C10 = s155_try_(function () { return { timeZone: new A.GasClockAdapter().timeZone() }; });
  out.C11 = s155_try_(function () {
    var random = new A.GasRandomAdapter();
    var min = 1;
    var max = 0;
    var distinct = {};
    for (var i = 0; i < 1000; i++) {
      var v = random.next();
      min = Math.min(min, v);
      max = Math.max(max, v);
      distinct[v] = true;
    }
    return { calls: 1000, min: min, max: max, distinct: Object.keys(distinct).length, allInRange: min >= 0 && max < 1 };
  });
  return out;
}

function s155_checkP_(A) {
  var store = PropertiesService.getScriptProperties();
  var out = {};
  out.P1 = s155_try_(function () {
    new A.GasStateAdapter().set('state.smoke', { v: 1, text: '\u00e9\u65e5\ud83d\ude42' });
    var fresh = new A.GasStateAdapter();
    var got = fresh.get('state.smoke');
    var raw = store.getProperty('state.smoke');
    return { get: got, keys: fresh.keys('state.smoke'), raw: raw, rawIsExpected: raw === '{"v":1,"text":"\u00e9\u65e5\ud83d\ude42"}' };
  });
  out.P2 = s155_try_(function () {
    new A.GasStateAdapter().delete('state.smoke');
    var got = new A.GasStateAdapter().get('state.smoke');
    return { getIsUndefined: got === undefined, rawIsNull: store.getProperty('state.smoke') === null };
  });
  return out;
}

// ---------------------------------------------------------------- the end

/**
 * The clean-up of the issue's "At the end", each step with its result:
 * `uninstall`; no `onTrigger` trigger and no `state.*` key left; the key and
 * the inputs deleted; the `s155_other` trigger removed; then, unless
 * `args.keepMail`, the synthetic threads and the classifier's emails moved to
 * Trash, and, unless `args.keepLabels`, the `JevSmoke…` labels deleted
 * (`Jev/Error` and `Jev` too with `args.deleteJevError`). It never touches
 * another spike's trigger or property.
 */
function s155_cleanup(args) {
  args = args || {};
  var out = {};
  var store = PropertiesService.getScriptProperties();
  if (typeof globalThis.uninstall === 'function') {
    out.uninstall = s155_try_(function () { return globalThis.uninstall(); });
  } else {
    out.uninstall = 'the product bundle is not in the project';
  }
  var deletedProps = [];
  Object.keys(store.getProperties()).forEach(function (key) {
    if (s155_allowedProp_(key)) {
      store.deleteProperty(key);
      deletedProps.push(key === 'JEV_API_KEY' || /^MANUAL_|^RESET_/.test(key) ? key : 'state.*');
    }
  });
  out.propertiesDeleted = deletedProps.filter(function (v, i) { return deletedProps.indexOf(v) === i; });
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (s155_K.triggerHandlers.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
      removed += 1;
    }
  });
  out.triggersRemoved = removed;
  if (!args.keepMail) {
    out.trashed = { synthetic: s155_trash({ what: 'synthetic' }), alerts: s155_trash({ what: 'alerts' }) };
  }
  if (!args.keepLabels) {
    out.labelsDeleted = [];
    (Gmail.Users.Labels.list('me').labels || [])
      .filter(function (l) {
        if (s155_smokeLabel_(l.name)) return true;
        return args.deleteJevError === true && (l.name === 'Jev' || l.name === 'Jev/Error');
      })
      .sort(function (a, b) { return b.name.length - a.name.length; })
      .forEach(function (l) {
        Gmail.Users.Labels.remove('me', l.id);
        out.labelsDeleted.push(l.name);
      });
  }
  out.after = { state: s155_props_(), triggers: s155_triggers_() };
  return s155_out_(out);
}
