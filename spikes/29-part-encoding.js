/**
 * s29: how the Advanced Gmail Service returns MIME part data, and how to
 * decode it to text in Apps Script (task #29, story #28).
 *
 * Runnable functions (each returns a JSON-serializable, address-free result
 * and also logs it):
 *   s29_utilitiesChecks()            No Gmail calls: charset names, padding, signed bytes.
 *   s29_createTestMessages(force)    Inserts scenarios 1-11, imports 3b and 13.
 *   s29_inspect(threadIdOrScenario)  Walks one thread's parts and tries every decode path.
 *   s29_inspectAll()                 s29_inspect on every scenario, plus 12 and 14 by subject.
 *   s29_dumpFixture(scenario, page, pageSize)  The scrubbed threads.get response, paged.
 *   s29_reset()                      Deletes this spike's Script Properties (not the mail).
 *
 * Conventions (spikes/README.md): top-level names start with s29_, Script
 * Properties keys start with s29., no GmailApp. Helpers end in "_" so they are
 * private (not runnable from the editor or scripts.run).
 *
 * The test account's address is never returned or logged: every result goes
 * through s29_out_(), which replaces it, and fixtures are scrubbed and then
 * checked by s29_scrubFixture_().
 */

var s29_PROP_THREADS = 's29.threads';
var s29_DATE = 'Thu, 24 Sep 2026 12:00:00 +0000';
var s29_FAKE_ACCOUNT = 'test-account@example.com';

/* ------------------------------------------------------------------ */
/* Runnable functions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Checks Utilities behavior that needs no Gmail call: which charset names
 * getDataAsString accepts, whether base64DecodeWebSafe needs padding, and
 * whether byte arrays are signed.
 */
function s29_utilitiesChecks() {
  var samples = {
    latin: 'Café naïve Müller £20 ß',
    cp1252: '“curly” ‘single’ €5 — – … ™ •',
    japanese: '日本語のテキスト。こんにちは世界。',
    russian: 'Привет, мир',
    chinese: '中文测试',
    ascii: 'plain ASCII text'
  };
  // [label, charset used to encode the bytes, name passed to getDataAsString, sample key]
  var cases = [
    ['UTF-8', 'UTF-8', 'UTF-8', 'japanese'],
    ['utf-8 (lower case)', 'UTF-8', 'utf-8', 'japanese'],
    ['utf8 (no dash)', 'UTF-8', 'utf8', 'japanese'],
    ['UTF8', 'UTF-8', 'UTF8', 'japanese'],
    ['ISO-8859-1', 'ISO-8859-1', 'ISO-8859-1', 'latin'],
    ['iso-8859-1', 'ISO-8859-1', 'iso-8859-1', 'latin'],
    ['latin1', 'ISO-8859-1', 'latin1', 'latin'],
    ['windows-1252', 'windows-1252', 'windows-1252', 'cp1252'],
    ['cp1252', 'windows-1252', 'cp1252', 'cp1252'],
    ['windows-1252 bytes read as ISO-8859-1', 'windows-1252', 'ISO-8859-1', 'cp1252'],
    ['Shift_JIS', 'Shift_JIS', 'Shift_JIS', 'japanese'],
    ['shift-jis', 'Shift_JIS', 'shift-jis', 'japanese'],
    ['ISO-2022-JP', 'ISO-2022-JP', 'ISO-2022-JP', 'japanese'],
    ['EUC-JP', 'EUC-JP', 'EUC-JP', 'japanese'],
    ['GB2312', 'GB2312', 'GB2312', 'chinese'],
    ['Big5', 'Big5', 'Big5', 'chinese'],
    ['KOI8-R', 'KOI8-R', 'KOI8-R', 'russian'],
    ['us-ascii', 'US-ASCII', 'us-ascii', 'ascii'],
    ['x-unknown', 'UTF-8', 'x-unknown', 'japanese'],
    ['unknown-8bit', 'UTF-8', 'unknown-8bit', 'japanese'],
    ['empty string', 'UTF-8', '', 'japanese'],
    ['UTF-8 bytes read as ISO-8859-1', 'UTF-8', 'ISO-8859-1', 'latin']
  ];
  var charsets = cases.map(function (c) {
    var text = samples[c[3]];
    var row = { case: c[0], encodedWith: c[1], decodeName: c[2] };
    try {
      var bytes = s29_enc_(text, c[1]);
      row.byteLength = bytes.length;
      var decoded = Utilities.newBlob(bytes).getDataAsString(c[2]);
      row.result = decoded === text ? 'correct' : 'garbled';
      row.decoded = decoded.slice(0, 40);
    } catch (e) {
      row.result = 'throws';
      row.error = String(e && e.message || e).slice(0, 200);
    }
    return row;
  });

  // getDataAsString() with no argument, on UTF-8 bytes.
  var noArg = s29_try_(function () {
    return Utilities.newBlob(s29_enc_(samples.japanese, 'UTF-8')).getDataAsString();
  }, samples.japanese);

  // Padding: 'a' -> 'YQ==', 'ab' -> 'YWI=', 'abc' -> 'YWJj'.
  var padding = ['YQ==', 'YQ', 'YWI=', 'YWI', 'YWJj', 'YQ=', '-_8', '-_8='].map(function (s) {
    return {
      input: s,
      result: s29_try_(function () {
        var b = Utilities.base64DecodeWebSafe(s);
        return b.map(function (x) { return x; }).join(',');
      })
    };
  });

  var signed = s29_enc_('é€', 'UTF-8');
  var result = {
    charsets: charsets,
    getDataAsStringNoArgument: noArg,
    base64DecodeWebSafePadding: padding,
    bytesOfUtf8EAcuteEuro: signed,
    bytesAreSigned: signed.some(function (b) { return b < 0; }),
    base64EncodeWebSafeOfA: Utilities.base64EncodeWebSafe('a'),
    newBlobAcceptsUnsignedBytes: s29_try_(function () {
      return Utilities.newBlob([0xC3, 0xA9]).getDataAsString('UTF-8');
    }, 'é')
  };
  return s29_out_(result, false);
}

/**
 * Inserts scenarios 1-11 and imports 3b and 13. Saves {scenario: {id,
 * threadId, method}} in Script Properties (s29.threads). Idempotent unless
 * force is true, so a re-run doesn't duplicate the mail.
 *
 * Scenario 1 is inserted three ways to record which call forms the Advanced
 * Service accepts: `raw` (base64url string in the resource, options in the
 * 4th argument), `media` (a message/rfc822 blob as the 3rd argument), and
 * `raw-noopts` (raw, no options, so internalDate is the insert time). The
 * rest use the first form that worked, falling back to the others.
 */
function s29_createTestMessages(force) {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty(s29_PROP_THREADS);
  if (existing && !force) {
    return s29_out_({ alreadyCreated: true, scenarios: JSON.parse(existing) }, null);
  }
  var nonce = String(Date.now());
  var defs = s29_defs_();
  var created = {};
  var errors = {};

  // 1. Probe the insert call forms with scenario 1.
  var forms = ['raw', 'media', 'raw-noopts'];
  var formResults = {};
  var working = [];
  forms.forEach(function (form, i) {
    var key = i === 0 ? '01' : '01-' + form;
    var built = s29_build_(defs['01'], nonce, i === 0 ? '' : ' [' + form + ' probe]');
    try {
      var msg = s29_insertOrImport_('insert', form, built.bytes);
      formResults[form] = { ok: true };
      created[key] = s29_created_(msg, 'insert:' + form);
      working.push(form);
    } catch (e) {
      formResults[form] = { ok: false, error: s29_err_(e) };
    }
  });
  if (!working.length) {
    return s29_out_({ error: 'no insert form worked', insertForms: formResults }, null);
  }

  // 2. Every other scenario: insert or import, preferring the working forms in order.
  var importName = s29_importName_();
  Object.keys(defs).sort().forEach(function (key) {
    var def = defs[key];
    if (key === '01' || def.method === 'maintainer') return;
    var built = s29_build_(def, nonce, '');
    var tried = [];
    for (var i = 0; i < working.length; i++) {
      try {
        var msg = s29_insertOrImport_(def.method, working[i], built.bytes);
        created[key] = s29_created_(msg, def.method + ':' + working[i]);
        return;
      } catch (e) {
        tried.push({ form: working[i], error: s29_err_(e) });
      }
    }
    errors[key] = tried;
  });

  // 3. Record each message's labelIds (does import add CATEGORY_* or SPAM?).
  Object.keys(created).forEach(function (key) {
    try {
      var m = Gmail.Users.Messages.get('me', created[key].id, { format: 'minimal' });
      created[key].labelIds = m.labelIds || [];
      created[key].internalDate = m.internalDate;
    } catch (e) {
      created[key].labelError = s29_err_(e);
    }
  });

  var store = {};
  Object.keys(created).forEach(function (k) {
    store[k] = { id: created[k].id, threadId: created[k].threadId, method: created[k].method };
  });
  props.setProperty(s29_PROP_THREADS, JSON.stringify(store));

  return s29_out_({
    insertForms: formResults,
    importMethodName: importName,
    scenarios: created,
    errors: errors,
    storedBytes: JSON.stringify(store).length
  }, null);
}

/**
 * Walks every part of one thread (format: 'full') and reports how its data
 * arrives, then tries decode paths A-D on each text part.
 * Accepts a thread ID or a scenario key ('01', '03b', '12', ...).
 */
function s29_inspect(threadIdOrScenario) {
  var ctx = s29_ctx_();
  var target = s29_resolve_(threadIdOrScenario || '01');
  if (target.error) return s29_out_(target, ctx);
  var result = s29_inspectThread_(target, ctx);
  return s29_out_(result, ctx);
}

/** s29_inspect on every scenario. Finds scenarios 12 and 14 by subject. */
function s29_inspectAll() {
  var ctx = s29_ctx_();
  var keys = Object.keys(s29_defs_());
  var stored = s29_stored_();
  Object.keys(stored).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
  keys.sort(); // '01', '01-media', ..., '03b', ..., '14' (integer-like keys would otherwise come first)
  var out = {};
  keys.forEach(function (key) {
    var target = s29_resolve_(key);
    if (target.error) { out[key] = target; return; }
    try {
      out[key] = s29_inspectThread_(target, ctx);
    } catch (e) {
      out[key] = { error: s29_err_(e) };
    }
  });
  return s29_out_(out, ctx);
}

/**
 * Returns the scrubbed threads.get (format: 'full') response for one scenario,
 * plus the matching expected-text map, as one JSON string split into pages:
 *   {"fixture": <threads.get response>, "expected": {"<partId>": "<text>"}}
 * Concatenate `json` across pages 0..pages-1 and parse it. Save `fixture` as
 * test/fixtures/gmail/NN-slug.json and `expected` as NN-slug.expected.json.
 */
function s29_dumpFixture(scenario, page, pageSize) {
  var ctx = s29_ctx_();
  var key = s29_key_(scenario || '01');
  var target = s29_resolve_(key);
  if (target.error) return s29_out_(target, ctx);
  var size = pageSize || 250000;
  var thread = Gmail.Users.Threads.get('me', target.threadId, { format: 'full' });
  var expected = s29_expectedMap_(thread, target, ctx);
  var notes = [];
  var fixture = s29_scrubFixture_(thread, target.key, ctx, notes);
  var json = JSON.stringify({ fixture: fixture, expected: expected.map });
  s29_assertClean_(json, ctx);
  var pages = Math.max(1, Math.ceil(json.length / size));
  var p = Math.min(Math.max(0, page || 0), pages - 1);
  var result = {
    scenario: target.key,
    slug: target.slug,
    fileBase: target.key + '-' + target.slug,
    page: p,
    pages: pages,
    totalChars: json.length,
    expectedSource: expected.source,
    scrubNotes: notes,
    json: json.slice(p * size, (p + 1) * size)
  };
  // Log only the metadata: the page itself can be large.
  console.log(JSON.stringify({ scenario: result.scenario, page: p, pages: pages, totalChars: json.length }));
  return result;
}

/** Deletes this spike's Script Properties. The test mail is left in place. */
function s29_reset() {
  var props = PropertiesService.getScriptProperties();
  var deleted = props.getKeys().filter(function (k) { return k.indexOf('s29.') === 0; });
  deleted.forEach(function (k) { props.deleteProperty(k); });
  return s29_out_({ deleted: deleted }, false);
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

/** Scenario definitions, in order. `build(nonce, suffix)` returns a MIME entity tree. */
function s29_defs_() {
  var T = s29_texts_();
  var defs = {};
  function add(key, slug, method, subject, build) {
    defs[key] = { key: key, slug: slug, method: method, subject: subject, build: build };
  }
  add('01', 'plain-utf8-7bit', 'insert', 's29-01 plain utf8 7bit', function () {
    return s29_leaf_({ type: 'text/plain', params: '; charset="UTF-8"', cte: '7bit', text: T.s01 });
  });
  add('02', 'html-utf8-qp', 'insert', 's29-02 html utf8 quoted-printable', function () {
    return s29_leaf_({ type: 'text/html', params: '; charset="UTF-8"', cte: 'quoted-printable', text: T.s02 });
  });
  add('03', 'alternative-utf8-base64', 'insert', 's29-03 alternative utf8 base64', function () {
    return s29_multi_('alternative', [
      s29_leaf_({ type: 'text/plain', params: '; charset="UTF-8"', cte: 'base64', text: T.s03plain }),
      s29_leaf_({ type: 'text/html', params: '; charset="UTF-8"', cte: 'base64', text: T.s03html })
    ]);
  });
  add('03b', 'alternative-utf8-base64-import', 'import', 's29-03b alternative utf8 base64 (import)', function () {
    return defs['03'].build();
  });
  add('04', 'mixed-attachments', 'insert', 's29-04 mixed with attachments', function () {
    return s29_multi_('mixed', [
      s29_multi_('alternative', [
        s29_leaf_({ type: 'text/plain', params: '; charset="UTF-8"', cte: 'quoted-printable', text: T.s04plain }),
        s29_leaf_({ type: 'text/html', params: '; charset="UTF-8"', cte: 'quoted-printable', text: T.s04html })
      ]),
      s29_leaf_({
        type: 'application/pdf', params: '; name="s29-sample.pdf"', cte: 'base64',
        bytes: s29_ascii_(T.s04pdf), text: null,
        disposition: 'attachment; filename="s29-sample.pdf"'
      }),
      s29_leaf_({
        type: 'text/plain', params: '; charset="UTF-8"; name="notes.txt"', cte: 'base64',
        text: T.s04txt, disposition: 'attachment; filename="notes.txt"'
      })
    ]);
  });
  add('05', 'plain-iso-8859-1-qp', 'insert', 's29-05 plain iso-8859-1 quoted-printable', function () {
    return s29_leaf_({ type: 'text/plain', params: '; charset="ISO-8859-1"', cte: 'quoted-printable', text: T.s05, charset: 'ISO-8859-1' });
  });
  add('06', 'html-windows-1252-qp', 'insert', 's29-06 html windows-1252 quoted-printable', function () {
    return s29_leaf_({ type: 'text/html', params: '; charset="windows-1252"', cte: 'quoted-printable', text: T.s06, charset: 'windows-1252' });
  });
  add('07', 'plain-multibyte-base64', 'insert', 's29-07 plain shift_jis and iso-2022-jp base64', function () {
    return s29_multi_('mixed', [
      s29_leaf_({ type: 'text/plain', params: '; charset="Shift_JIS"', cte: 'base64', text: T.s07sjis, charset: 'Shift_JIS' }),
      s29_leaf_({ type: 'text/plain', params: '; charset="ISO-2022-JP"', cte: 'base64', text: T.s07jis, charset: 'ISO-2022-JP' })
    ]);
  });
  add('08', 'plain-no-charset-8bit', 'insert', 's29-08 plain no charset 8bit', function () {
    return s29_multi_('mixed', [
      s29_leaf_({ type: 'text/plain', params: '', cte: '8bit', text: T.s08utf8, charset: 'UTF-8' }),
      s29_leaf_({ type: 'text/plain', params: '', cte: '8bit', text: T.s08latin, charset: 'ISO-8859-1' })
    ]);
  });
  add('09', 'plain-unknown-charset', 'insert', 's29-09 plain unknown and alias charsets', function () {
    return s29_multi_('mixed', [
      s29_leaf_({ type: 'text/plain', params: '; charset="x-unknown"', cte: 'base64', text: T.s09unknown }),
      s29_leaf_({ type: 'text/plain', params: '; charset=utf8', cte: 'base64', text: T.s09utf8 })
    ]);
  });
  add('10', 'rfc2047-headers', 'insert', null, function () {
    return s29_leaf_({ type: 'text/plain', params: '; charset="UTF-8"', cte: '7bit', text: T.s10 });
  });
  add('11', 'large-plain', 'insert', 's29-11 large plain body', function () {
    return s29_leaf_({ type: 'text/plain', params: '; charset="UTF-8"', cte: '7bit', text: T.s11 });
  });
  add('12', 'gmail-composed-html', 'maintainer', 's29-12 Größe café 日本', null);
  add('13', 'calendar-invite', 'import', 's29-13 calendar invite', function () {
    return s29_multi_('mixed', [
      s29_multi_('alternative', [
        s29_leaf_({ type: 'text/plain', params: '; charset="UTF-8"', cte: 'quoted-printable', text: T.s13plain }),
        s29_leaf_({ type: 'text/html', params: '; charset="UTF-8"', cte: 'quoted-printable', text: T.s13html }),
        s29_leaf_({ type: 'text/calendar', params: '; charset="UTF-8"; method=REQUEST', cte: '7bit', text: T.s13ics })
      ]),
      s29_leaf_({
        type: 'application/ics', params: '; name="invite.ics"', cte: 'base64',
        text: T.s13ics, disposition: 'attachment; filename="invite.ics"'
      })
    ]);
  });
  add('14', 'forward-as-attachment', 'maintainer', 's29-14 forward', null);
  return defs;
}

/** Known source text for every scenario (CRLF line endings, as sent). */
function s29_texts_() {
  var large = [];
  for (var i = 0; i < 13100; i++) {
    large.push('Scenario 11 line ' + ('00000' + i).slice(-5) + ': the quick brown fox jumps over the lazy dog, again.');
  }
  var ics = [
    'BEGIN:VCALENDAR', 'PRODID:-//s29 spike//synthetic//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
    'BEGIN:VEVENT', 'DTSTART:20261001T150000Z', 'DTEND:20261001T153000Z', 'DTSTAMP:20260924T120000Z',
    'ORGANIZER;CN=Organizer:mailto:organizer@example.com', 'UID:s29-13-invite@example.com',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Attendee:mailto:attendee@example.org',
    'SUMMARY:s29-13 synthetic meeting', 'DESCRIPTION:Synthetic invite for the s29 spike.', 'LOCATION:Room 1',
    'SEQUENCE:0', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n') + '\r\n';
  var pdfLines = ['%PDF-1.4', '% synthetic s29 attachment, not a real document'];
  for (var j = 0; j < 40; j++) pdfLines.push('% padding line ' + j + ' ................................................');
  pdfLines.push('trailer', '<<>>', '%%EOF');
  return {
    s01: 'Scenario 1: text/plain only, UTF-8, 7bit.\r\nSecond line, ASCII only.\r\n',
    s02: '<html><head><style>p { color: #333; }</style></head><body>' +
      '<p>Scenario 2: HTML only, UTF-8, quoted-printable. Café, naïve, “quotes”, an equals sign a=b.</p>' +
      '<p>This paragraph is deliberately longer than seventy-six characters so that quoted-printable needs a soft line break.</p>' +
      '</body></html>\r\n',
    s03plain: 'Scenario 3: multipart/alternative, UTF-8, base64.\r\nGrüße, 日本語, emoji 🙂.\r\n',
    s03html: '<html><body><p>Scenario 3: multipart/alternative, UTF-8, base64.</p><p>Grüße, 日本語, emoji 🙂.</p></body></html>\r\n',
    s04plain: 'Scenario 4: body of a multipart/mixed message with two attachments. Café.\r\n',
    s04html: '<html><body><p>Scenario 4: body of a multipart/mixed message with two attachments. Café.</p></body></html>\r\n',
    s04txt: 'Synthetic notes attachment for s29-04.\r\n',
    s04pdf: pdfLines.join('\n') + '\n',
    s05: 'Scenario 5: text/plain, ISO-8859-1, quoted-printable.\r\nCafé, naïve, Müller, £20, ü é à ç ß ±.\r\n',
    s06: '<html><body><p>Scenario 6: windows-1252 “curly quotes”, ‘single’, € 5, em dash — en dash –, ellipsis …, trademark ™, bullet •.</p></body></html>\r\n',
    s07sjis: 'シナリオ７：Shift_JIS のテキスト。日本語です。\r\n',
    s07jis: 'シナリオ７：ISO-2022-JP のテキスト。こんにちは世界。\r\n',
    s08utf8: 'Scenario 8a: no charset parameter, UTF-8 bytes: café Grüße.\r\n',
    s08latin: 'Scenario 8b: no charset parameter, ISO-8859-1 bytes: café Grüße.\r\n',
    s09unknown: 'Scenario 9a: charset="x-unknown", UTF-8 bytes: café 日本.\r\n',
    s09utf8: 'Scenario 9b: charset=utf8 (no dash), UTF-8 bytes: café 日本.\r\n',
    s10: 'Scenario 10: RFC 2047 encoded Subject, From, and To display names. ASCII body.\r\n',
    s11: large.join('\r\n') + '\r\n',
    s12marker: 'Größe café 日本',
    s13plain: 'Scenario 13: synthetic calendar invite.\r\nWhen: 2026-10-01 15:00 UTC.\r\n',
    s13html: '<html><body><p>Scenario 13: synthetic calendar invite.</p><p>When: 2026-10-01 15:00 UTC.</p></body></html>\r\n',
    s13ics: ics
  };
}

/** Builds one scenario's MIME bytes and its list of expected leaves. */
function s29_build_(def, nonce, subjectSuffix) {
  var body = def.build();
  var headers = [];
  var raw = {};
  if (def.key === '10') {
    var sub = 's29-10 ' + s29_encodedWordB_('Grüße aus') + '\r\n ' + s29_encodedWordB_(' 日本 encoded subject');
    raw = {
      Subject: sub,
      From: s29_encodedWordQ_('José Müller', 'ISO-8859-1') + ' <jose@example.com>',
      To: s29_encodedWordQ_('Grüße Empfänger', 'UTF-8') + ' <recipient@example.org>'
    };
    headers.push(['From', raw.From], ['To', raw.To], ['Subject', raw.Subject + subjectSuffix]);
  } else {
    headers.push(['From', 'Synthetic Sender <sender@example.com>'], ['To', 'Recipient <recipient@example.org>'],
      ['Subject', def.subject + subjectSuffix]);
  }
  headers.push(['Date', s29_DATE],
    ['Message-ID', '<s29-' + def.key + '.' + nonce + (subjectSuffix ? '.probe' + subjectSuffix.length : '') + '@example.com>'],
    ['MIME-Version', '1.0']);
  var top = { headers: headers.concat(body.headers), bodyBytes: body.bodyBytes, parts: body.parts, boundary: body.boundary };
  return { bytes: s29_serialize_(top), leaves: s29_leaves_(body), rawHeaders: raw };
}

/* ------------------------------------------------------------------ */
/* MIME building                                                       */
/* ------------------------------------------------------------------ */

var s29_boundaryCounter = 0;

function s29_leaf_(o) {
  var bytes = o.bytes || s29_enc_(o.text, o.charset || 'UTF-8');
  var body;
  if (o.cte === 'base64') body = s29_ascii_(s29_b64Lines_(bytes));
  else if (o.cte === 'quoted-printable') body = s29_ascii_(s29_qp_(bytes));
  else body = bytes;
  var headers = [['Content-Type', o.type + (o.params || '')]];
  if (o.cte) headers.push(['Content-Transfer-Encoding', o.cte]);
  if (o.disposition) headers.push(['Content-Disposition', o.disposition]);
  return {
    headers: headers,
    bodyBytes: body,
    expect: { mimeType: o.type, text: o.text || null, attachment: !!o.disposition }
  };
}

function s29_multi_(subtype, parts) {
  s29_boundaryCounter++;
  var b = 's29b_' + subtype + '_' + s29_boundaryCounter;
  return { headers: [['Content-Type', 'multipart/' + subtype + '; boundary="' + b + '"']], boundary: b, parts: parts };
}

function s29_serialize_(e) {
  var chunks = [];
  var head = '';
  e.headers.forEach(function (h) { head += h[0] + ': ' + h[1] + '\r\n'; });
  chunks.push(s29_ascii_(head + '\r\n'));
  if (e.parts) {
    e.parts.forEach(function (p) {
      chunks.push(s29_ascii_('--' + e.boundary + '\r\n'));
      chunks.push(s29_serialize_(p));
      chunks.push(s29_ascii_('\r\n'));
    });
    chunks.push(s29_ascii_('--' + e.boundary + '--\r\n'));
  } else {
    chunks.push(e.bodyBytes);
  }
  return s29_concat_(chunks);
}

/** Leaves (non-multipart entities) in depth-first order, which is Gmail's partId order. */
function s29_leaves_(e) {
  if (!e.parts) return [e.expect];
  var out = [];
  e.parts.forEach(function (p) { out = out.concat(s29_leaves_(p)); });
  return out;
}

function s29_ascii_(s) {
  return Utilities.newBlob('').setDataFromString(s, 'US-ASCII').getBytes();
}

function s29_enc_(s, charset) {
  return Utilities.newBlob('').setDataFromString(s, charset).getBytes();
}

function s29_concat_(arrays) {
  var out = [];
  for (var i = 0; i < arrays.length; i++) {
    var a = arrays[i];
    for (var j = 0; j < a.length; j++) out.push(a[j]);
  }
  return out;
}

function s29_b64Lines_(bytes) {
  var s = Utilities.base64Encode(bytes);
  return s.match(/.{1,76}/g).join('\r\n') + '\r\n';
}

/** Quoted-printable over bytes. CRLF pairs are kept as hard line breaks. */
function s29_qp_(bytes) {
  var out = '';
  var line = '';
  function flushTrailing(l) {
    var c = l.charAt(l.length - 1);
    if (c === ' ') return l.slice(0, -1) + '=20';
    if (c === '\t') return l.slice(0, -1) + '=09';
    return l;
  }
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    if (b === 13 && i + 1 < bytes.length && (bytes[i + 1] & 0xff) === 10) {
      out += flushTrailing(line) + '\r\n';
      line = '';
      i++;
      continue;
    }
    var tok = ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9)
      ? String.fromCharCode(b)
      : '=' + ('0' + b.toString(16).toUpperCase()).slice(-2);
    if (line.length + tok.length > 72) {
      out += line + '=\r\n';
      line = '';
    }
    line += tok;
  }
  return out + flushTrailing(line);
}

function s29_encodedWordB_(text) {
  return '=?UTF-8?B?' + Utilities.base64Encode(s29_enc_(text, 'UTF-8')) + '?=';
}

function s29_encodedWordQ_(text, charset) {
  var bytes = s29_enc_(text, charset);
  var s = '';
  bytes.forEach(function (x) {
    var b = x & 0xff;
    if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122)) s += String.fromCharCode(b);
    else if (b === 32) s += '_';
    else s += '=' + ('0' + b.toString(16).toUpperCase()).slice(-2);
  });
  return '=?' + charset + '?Q?' + s + '?=';
}

/* ------------------------------------------------------------------ */
/* Insert and import                                                   */
/* ------------------------------------------------------------------ */

/** The Advanced Service name for users.messages.import ('import' is a reserved word). */
function s29_importName_() {
  var m = Gmail.Users.Messages;
  var names = ['import', 'import_', 'importMessage'];
  for (var i = 0; i < names.length; i++) {
    if (typeof m[names[i]] === 'function') return names[i];
  }
  return null;
}

function s29_insertOrImport_(method, form, bytes) {
  var labelIds = ['INBOX', 'UNREAD'];
  var opts = { internalDateSource: 'dateHeader' };
  var fnName = 'insert';
  if (method === 'import') {
    opts.neverMarkSpam = true;
    fnName = s29_importName_();
    if (!fnName) throw new Error('no import method on Gmail.Users.Messages');
  }
  var M = Gmail.Users.Messages;
  if (form === 'raw') {
    return M[fnName]({ raw: Utilities.base64EncodeWebSafe(bytes), labelIds: labelIds }, 'me', null, opts);
  }
  if (form === 'media') {
    var blob = Utilities.newBlob(bytes, 'message/rfc822', 'message.eml');
    return M[fnName]({ labelIds: labelIds }, 'me', blob, opts);
  }
  if (form === 'raw-noopts') {
    return M[fnName]({ raw: Utilities.base64EncodeWebSafe(bytes), labelIds: labelIds }, 'me');
  }
  throw new Error('unknown form ' + form);
}

function s29_created_(msg, method) {
  return { id: msg.id, threadId: msg.threadId, method: method };
}

/* ------------------------------------------------------------------ */
/* Inspection                                                          */
/* ------------------------------------------------------------------ */

function s29_stored_() {
  var raw = PropertiesService.getScriptProperties().getProperty(s29_PROP_THREADS);
  return raw ? JSON.parse(raw) : {};
}

function s29_key_(k) {
  var s = String(k);
  return /^\d$/.test(s) ? '0' + s : s;
}

/** Finds the thread for a scenario key or thread ID: {key, slug, threadId, def}. */
function s29_resolve_(idOrKey) {
  var defs = s29_defs_();
  var stored = s29_stored_();
  var key = s29_key_(idOrKey);
  if (!defs[key] && !stored[key]) {
    var found = Object.keys(stored).filter(function (k) { return stored[k].threadId === idOrKey; })[0];
    if (!found) return { error: 'unknown scenario or thread', input: String(idOrKey) };
    key = found;
  }
  var def = defs[key] || defs[key.slice(0, 2)];
  if (stored[key]) {
    return { key: key, slug: defs[key] ? def.slug : def.slug + '-' + key.slice(3), threadId: stored[key].threadId, def: def, method: stored[key].method };
  }
  if (def.method === 'maintainer') {
    var t = s29_findBySubject_(def.subject.slice(0, 6));
    if (!t) return { key: key, error: 'not found by subject; maintainer step not done yet?', subjectPrefix: def.subject.slice(0, 6) };
    return { key: key, slug: def.slug, threadId: t, def: def, method: 'maintainer (Gmail UI)' };
  }
  return { key: key, error: 'not created yet: run s29_createTestMessages first' };
}

/** Thread whose first message's Subject starts with the prefix (for example 's29-12'). */
function s29_findBySubject_(prefix) {
  var list = Gmail.Users.Threads.list('me', { q: 'subject:"' + prefix + '"', maxResults: 10 });
  var threads = (list && list.threads) || [];
  for (var i = 0; i < threads.length; i++) {
    var t = Gmail.Users.Threads.get('me', threads[i].id, { format: 'metadata', metadataHeaders: ['Subject'] });
    var subject = s29_header_(t.messages[0].payload.headers, 'Subject') || '';
    if (subject.indexOf(prefix) === 0) return t.id;
  }
  return null;
}

function s29_inspectThread_(target, ctx) {
  var thread = Gmail.Users.Threads.get('me', target.threadId, { format: 'full' });
  var built = target.def.build ? s29_build_(target.def, 'x', '') : null;
  var leaves = built ? built.leaves : [];
  var marker = target.def.method === 'maintainer' ? s29_texts_().s12marker : null;
  var messages = (thread.messages || []).map(function (m) {
    var parts = [];
    var leafIndex = { i: 0 };
    s29_walk_(m.payload, function (part, depth) {
      var isLeaf = !(part.parts && part.parts.length) && !/^multipart\//i.test(part.mimeType || '');
      var expect = isLeaf ? leaves[leafIndex.i++] : null;
      parts.push(s29_inspectPart_(m.id, part, depth, expect, marker));
    });
    var h = m.payload.headers || [];
    return {
      labelIds: m.labelIds,
      sizeEstimate: m.sizeEstimate,
      internalDate: m.internalDate,
      headers: {
        Subject: s29_header_(h, 'Subject'),
        From: s29_scrubAddressHeader_('From', s29_header_(h, 'From'), ctx),
        To: s29_scrubAddressHeader_('To', s29_header_(h, 'To'), ctx)
      },
      rawHeadersInMime: built ? built.rawHeaders : null,
      parts: parts
    };
  });
  return { scenario: target.key, method: target.method, messageCount: messages.length, messages: messages };
}

function s29_walk_(part, fn, depth) {
  if (!part) return;
  fn(part, depth || 0);
  (part.parts || []).forEach(function (p) { s29_walk_(p, fn, (depth || 0) + 1); });
}

function s29_inspectPart_(messageId, part, depth, expect, marker) {
  var h = part.headers || [];
  var body = part.body || {};
  var info = {
    partId: part.partId,
    depth: depth,
    mimeType: part.mimeType,
    filename: part.filename,
    hasAttachmentId: !!body.attachmentId,
    bodySize: body.size,
    headerNames: h.map(function (x) { return x.name; }),
    contentType: s29_header_(h, 'Content-Type'),
    cte: s29_header_(h, 'Content-Transfer-Encoding'),
    contentDisposition: s29_header_(h, 'Content-Disposition'),
    hasNestedParts: !!(part.parts && part.parts.length),
    data: s29_dataFacts_(body.data)
  };
  var data = body.data;
  // Data behind an attachmentId: fetch it once to see its form.
  if (body.attachmentId) {
    try {
      var att = Gmail.Users.Messages.Attachments.get('me', messageId, body.attachmentId);
      info.attachmentsGet = { size: att.size, data: s29_dataFacts_(att.data) };
      if (!data) data = att.data;
    } catch (e) {
      info.attachmentsGet = { error: s29_err_(e) };
    }
  }
  var isText = /^text\//i.test(part.mimeType || '');
  if (isText && data !== undefined && data !== null) {
    var charset = s29_charsetOf_(info.contentType);
    info.declaredCharset = charset;
    info.expectedKnown = !!(expect && expect.text);
    info.decode = s29_decodeAttempts_(data, charset, expect && expect.text, marker);
    info.workingPath = Object.keys(info.decode).filter(function (k) {
      return info.decode[k].ok && (info.decode[k].matches === true || info.decode[k].containsMarker === true);
    });
  }
  return info;
}

function s29_dataFacts_(d) {
  if (d === undefined || d === null) return { present: false };
  var facts = {
    present: true,
    typeof: typeof d,
    isArray: Array.isArray(d),
    toStringTag: Object.prototype.toString.call(d),
    length: d.length
  };
  if (typeof d === 'string') {
    facts.head = d.slice(0, 8);
    facts.endsWithEquals = /=$/.test(d);
    facts.hasPlusOrSlash = /[+\/]/.test(d);
    facts.hasDashOrUnderscore = /[-_]/.test(d);
    facts.lengthMod4 = d.length % 4;
  } else if (d.length !== undefined) {
    var head = [];
    var min = Infinity;
    var max = -Infinity;
    var allBase64Alphabet = true;
    for (var i = 0; i < d.length; i++) {
      var v = d[i];
      if (i < 8) head.push(v);
      if (v < min) min = v;
      if (v > max) max = v;
      // A-Z a-z 0-9 - _ = + /
      if (allBase64Alphabet && !((v >= 65 && v <= 90) || (v >= 97 && v <= 122) || (v >= 48 && v <= 57) || v === 45 || v === 95 || v === 61 || v === 43 || v === 47)) {
        allBase64Alphabet = false;
      }
    }
    facts.head = head;
    facts.min = min;
    facts.max = max;
    facts.allBytesInBase64Alphabet = allBase64Alphabet;
  }
  return facts;
}

/**
 * Decode paths from the task:
 *   A  string: newBlob(base64DecodeWebSafe(data)).getDataAsString(charset)
 *   B  string with padding stripped, and padded to a multiple of 4
 *   C  byte array: newBlob(data).getDataAsString(charset); also C2, treating the
 *      array as the ASCII bytes of base64url text
 *   D  fallbacks for a missing or unknown charset: UTF-8, ISO-8859-1, windows-1252
 */
function s29_decodeAttempts_(data, charset, expectedText, marker) {
  var cs = charset || 'UTF-8';
  var out = {};
  var bytes = null;
  function attempt(name, fn) {
    out[name] = s29_try_(fn, expectedText, marker);
  }
  if (typeof data === 'string') {
    attempt('A', function () { return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString(cs); });
    var stripped = data.replace(/=+$/, '');
    var padded = stripped + '===='.slice(0, (4 - stripped.length % 4) % 4);
    attempt('B_stripped', function () { return Utilities.newBlob(Utilities.base64DecodeWebSafe(stripped)).getDataAsString(cs); });
    attempt('B_padded', function () { return Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString(cs); });
    try { bytes = Utilities.base64DecodeWebSafe(padded); } catch (e) { bytes = null; }
  } else if (data && data.length !== undefined) {
    attempt('C', function () { return Utilities.newBlob(data).getDataAsString(cs); });
    attempt('C2_asBase64Text', function () {
      var text = Utilities.newBlob(data).getDataAsString('US-ASCII');
      return Utilities.newBlob(Utilities.base64DecodeWebSafe(text)).getDataAsString(cs);
    });
    bytes = data;
  }
  if (bytes) {
    ['UTF-8', 'ISO-8859-1', 'windows-1252'].forEach(function (fb) {
      attempt('D_' + fb, function () { return Utilities.newBlob(bytes).getDataAsString(fb); });
    });
  }
  return out;
}

/** Runs fn and describes its result; compares with the expected text if known. */
function s29_try_(fn, expectedText, marker) {
  try {
    var v = fn();
    var r = { ok: true };
    if (typeof v === 'string') {
      r.first80 = v.slice(0, 80);
      r.length = v.length;
      if (expectedText) {
        r.matches = s29_norm_(v) === s29_norm_(expectedText);
        r.exact = v === expectedText;
      }
      if (marker) r.containsMarker = v.indexOf(marker) >= 0;
    } else {
      r.value = v;
    }
    return r;
  } catch (e) {
    return { ok: false, error: s29_err_(e) };
  }
}

function s29_norm_(s) {
  return String(s).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function s29_charsetOf_(contentType) {
  var m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType || '');
  return m ? m[1] : null;
}

function s29_header_(headers, name) {
  var lower = name.toLowerCase();
  for (var i = 0; i < (headers || []).length; i++) {
    if (String(headers[i].name).toLowerCase() === lower) return headers[i].value;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Fixtures and scrubbing                                              */
/* ------------------------------------------------------------------ */

/** Headers kept as returned: the SD section 8.3 allowlist plus MIME headers. */
var s29_KEEP_HEADERS = ['from', 'sender', 'reply-to', 'to', 'cc', 'subject', 'date', 'list-id',
  'list-unsubscribe', 'precedence', 'auto-submitted', 'mime-version', 'content-type',
  'content-transfer-encoding', 'content-disposition', 'content-id', 'content-description'];
var s29_ADDRESS_HEADERS = ['from', 'sender', 'reply-to', 'to', 'cc', 'list-unsubscribe'];

/** {"<partId>": "<decoded text>"} for each text part: known source text, or the decoded text if unknown. */
function s29_expectedMap_(thread, target, ctx) {
  var built = target.def.build ? s29_build_(target.def, 'x', '') : null;
  var leaves = built ? built.leaves : [];
  var map = {};
  var source = built ? 'spike source text' : 'decoded from the Gmail response (UI-composed; no source text)';
  var multi = (thread.messages || []).length > 1;
  (thread.messages || []).forEach(function (m, mi) {
    var idx = 0;
    s29_walk_(m.payload, function (part) {
      var isLeaf = !(part.parts && part.parts.length) && !/^multipart\//i.test(part.mimeType || '');
      if (!isLeaf) return;
      var expect = leaves[idx++];
      if (!/^text\//i.test(part.mimeType || '')) return;
      var key = (multi ? (mi + 1) + ':' : '') + part.partId;
      if (expect && expect.text) {
        map[key] = expect.text;
      } else {
        var text = s29_bestDecode_(m.id, part);
        if (text !== null) map[key] = s29_scrubString_(text, ctx);
      }
    });
  });
  return { map: map, source: source };
}

/** Decodes a text part with the first path that works (A, then C), using the declared charset or UTF-8. */
function s29_bestDecode_(messageId, part) {
  var body = part.body || {};
  var data = body.data;
  if ((data === undefined || data === null) && body.attachmentId) {
    data = Gmail.Users.Messages.Attachments.get('me', messageId, body.attachmentId).data;
  }
  if (data === undefined || data === null) return null;
  var cs = s29_charsetOf_(s29_header_(part.headers, 'Content-Type')) || 'UTF-8';
  var bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data.replace(/=+$/, '') + '===='.slice(0, (4 - data.replace(/=+$/, '').length % 4) % 4)) : data;
  try {
    return Utilities.newBlob(bytes).getDataAsString(cs);
  } catch (e) {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
}

/**
 * Applies the fixture rules from task #29: stable fake IDs, attachment IDs,
 * example.com/org addresses, REDACTED non-allowlisted header values, synthetic
 * snippet. Body data is kept as returned unless the decoded text contains the
 * account's address or local part (then it's re-encoded and noted).
 */
function s29_scrubFixture_(thread, key, ctx, notes) {
  var t = JSON.parse(JSON.stringify(thread));
  var addrMap = {};
  var attN = 0;
  t.id = 'thread-' + key;
  t.historyId = '1000';
  if (t.snippet !== undefined) t.snippet = 'Synthetic snippet for scenario ' + key + '.';
  (t.messages || []).forEach(function (m, mi) {
    var n = mi + 1;
    var realId = m.id;
    m.id = 'msg-' + key + '-' + n;
    m.threadId = 'thread-' + key;
    m.historyId = String(1000 + n);
    if (m.snippet !== undefined) m.snippet = 'Synthetic snippet for scenario ' + key + ', message ' + n + '.';
    s29_walk_(m.payload, function (part) {
      (part.headers || []).forEach(function (h) {
        var lower = String(h.name).toLowerCase();
        if (s29_KEEP_HEADERS.indexOf(lower) < 0) {
          h.value = 'REDACTED';
        } else if (s29_ADDRESS_HEADERS.indexOf(lower) >= 0) {
          h.value = s29_mapAddresses_(s29_scrubAddressHeader_(h.name, h.value, ctx), addrMap);
        } else {
          h.value = s29_mapAddresses_(h.value, addrMap);
        }
      });
      var body = part.body || {};
      if (body.attachmentId) {
        attN++;
        body.attachmentId = 'att-' + key + '-' + attN;
      }
      if (/^(text|message)\//i.test(part.mimeType || '') && body.data !== undefined && body.data !== null) {
        var text = null;
        try { text = s29_bestDecode_(realId, { headers: part.headers, body: { data: body.data } }); } catch (e) { text = null; }
        if (text !== null && s29_containsAccount_(text, ctx)) {
          var cs = s29_charsetOf_(s29_header_(part.headers, 'Content-Type')) || 'UTF-8';
          var newBytes = s29_enc_(s29_scrubString_(text, ctx), cs);
          if (typeof body.data === 'string') {
            var reenc = Utilities.base64EncodeWebSafe(newBytes);
            // Keep the padding style Gmail used.
            body.data = /=$/.test(body.data) ? reenc : reenc.replace(/=+$/, '');
          } else {
            body.data = newBytes;
          }
          body.size = newBytes.length;
          notes.push('part ' + m.id + '/' + part.partId + ': body re-encoded to remove the account identifier');
        }
      }
    });
  });
  // Any string outside body data that still names the account: replace it.
  s29_deepStrings_(t, function (s, k) {
    if (k === 'data') return s;
    return s29_scrubString_(s, ctx);
  });
  return t;
}

/** Replaces the account's address in an address header; drops its display name too. */
function s29_scrubAddressHeader_(name, value, ctx) {
  if (value === null || value === undefined || !ctx) return value;
  if (String(value).toLowerCase().indexOf(ctx.address) < 0) return value;
  var addrs = String(value).match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
  return addrs.map(function (a) {
    return a.toLowerCase() === ctx.address ? '"Test Account" <' + s29_FAKE_ACCOUNT + '>' : '<' + a + '>';
  }).join(', ');
}

/** Maps any address outside example.com/org/net to userN@example.com. */
function s29_mapAddresses_(value, addrMap) {
  if (value === null || value === undefined) return value;
  return String(value).replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, function (a) {
    var lower = a.toLowerCase();
    if (/@(.+\.)?example\.(com|org|net)$/.test(lower)) return a;
    if (!addrMap[lower]) addrMap[lower] = 'user' + (Object.keys(addrMap).length + 1) + '@example.com';
    return addrMap[lower];
  });
}

function s29_deepStrings_(obj, fn) {
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    if (typeof v === 'string') obj[k] = fn(v, k);
    else if (v && typeof v === 'object') s29_deepStrings_(v, fn);
  });
}

/* ------------------------------------------------------------------ */
/* Account-address safety                                              */
/* ------------------------------------------------------------------ */

/** The account's address, read at run time and never returned. */
function s29_ctx_() {
  var address = String(Gmail.Users.getProfile('me').emailAddress || '').toLowerCase();
  var local = address.split('@')[0];
  return { address: address, local: local.length >= 4 ? local : null };
}

function s29_containsAccount_(s, ctx) {
  if (!ctx || !ctx.address) return false;
  var lower = String(s).toLowerCase();
  return lower.indexOf(ctx.address) >= 0 || (ctx.local && lower.indexOf(ctx.local) >= 0);
}

function s29_scrubString_(s, ctx) {
  if (!ctx || !ctx.address) return s;
  var out = String(s).replace(new RegExp(s29_reEscape_(ctx.address), 'gi'), s29_FAKE_ACCOUNT);
  if (ctx.local) out = out.replace(new RegExp(s29_reEscape_(ctx.local), 'gi'), 'test-account');
  return out;
}

function s29_reEscape_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Throws (without naming the address) if the account's address is still in the JSON. */
function s29_assertClean_(json, ctx) {
  if (ctx && ctx.address && json.toLowerCase().indexOf(ctx.address) >= 0) {
    throw new Error('s29 scrub check failed: the account address is still present');
  }
}

/**
 * Scrubs, logs, and returns a result. ctx null: read the address now and scrub.
 * ctx false: the result can't contain account data (no Gmail call is made).
 */
function s29_out_(result, ctx) {
  var context = ctx === false ? null : (ctx || s29_ctx_());
  var json = s29_scrubString_(JSON.stringify(result), context);
  s29_assertClean_(json, context);
  console.log(json);
  return JSON.parse(json);
}

function s29_err_(e) {
  return String((e && e.message) || e).slice(0, 300);
}
