/**
 * Spike #94: how UrlFetchApp.fetchAll behaves with the options GasHttpAdapter
 * uses (muteHttpExceptions: true, followRedirects: false).
 *
 * Calls Jev WITHOUT any key, so it costs nothing and needs no secret. Returns
 * header names only (values only for content-type), and replaces identifiers
 * in bodies and messages with <id>.
 *
 * Run: node spikes/run.mjs push && node spikes/run.mjs run s94_run
 */

var S94_JEV_URL = 'https://api.typesafe.ai/v1/systemone';
var S94_BAD_HOST_URL = 'https://jev-smoke.invalid/';
var S94_NO_CONTENT_URL = 'https://www.google.com/generate_204';
var S94_REDIRECT_URL = 'https://google.com/';

/** Runs S1 to S5 and returns every result. */
function s94_run() {
  var result = { fn: 's94_run', at: new Date().toISOString() };
  result.s1 = s94_try_(s94_s1_);
  result.s2 = s94_try_(s94_s2_);
  result.s3 = s94_try_(s94_s3_);
  result.s4 = s94_s4_(result);
  result.s5 = s94_try_(s94_s5_);
  console.log(JSON.stringify(result));
  return result;
}

/** The adapter's request shape, for Jev without an Authorization header. */
function s94_jevRequest_() {
  return {
    url: S94_JEV_URL,
    method: 'post',
    headers: {},
    contentType: 'application/json',
    payload: JSON.stringify({
      model: 'jev-latest',
      state: [{ from: 'a@example.test', subject: 'S94 synthetic', body: 'Hello.' }],
      questions: { q1: { type: 'noul', instructions: 'Is this a greeting?' } }
    }),
    muteHttpExceptions: true,
    followRedirects: false
  };
}

function s94_getRequest_(url) {
  return { url: url, method: 'get', headers: {}, muteHttpExceptions: true, followRedirects: false };
}

/** S1: POST to Jev with no key. */
function s94_s1_() {
  var started = Date.now();
  var responses = UrlFetchApp.fetchAll([s94_jevRequest_()]);
  var out = s94_describe_(responses[0]);
  out.elapsedMs = Date.now() - started;
  return out;
}

/** S2: a batch of three, one to an unresolvable host. */
function s94_s2_() {
  var started = Date.now();
  try {
    var responses = UrlFetchApp.fetchAll([
      s94_jevRequest_(),
      s94_getRequest_(S94_BAD_HOST_URL),
      s94_getRequest_(S94_NO_CONTENT_URL)
    ]);
    return {
      threw: false,
      elapsedMs: Date.now() - started,
      responses: responses.map(function (r) {
        return r === null || r === undefined ? String(r) : s94_describe_(r);
      })
    };
  } catch (e) {
    return {
      threw: true,
      elapsedMs: Date.now() - started,
      errorName: e && e.name,
      errorType: Object.prototype.toString.call(e),
      message: s94_scrub_(e && e.message !== undefined ? e.message : String(e))
    };
  }
}

/** S3: a redirect with followRedirects: false. */
function s94_s3_() {
  var responses = UrlFetchApp.fetchAll([s94_getRequest_(S94_REDIRECT_URL)]);
  var r = responses[0];
  var headers = r.getAllHeaders();
  var location = s94_find_(headers, 'location');
  return {
    status: r.getResponseCode(),
    headerNames: Object.keys(headers),
    location: location === undefined ? undefined : String(location)
  };
}

/** S4: the value type getAllHeaders() gives a repeated header (set-cookie). */
function s94_s4_(previous) {
  var batches = [];
  ['s1', 's3'].forEach(function (k) {
    if (previous[k] && previous[k].headerTypes) {
      batches.push({ from: k, headerTypes: previous[k].headerTypes });
    }
  });
  // google.com's redirect usually sets cookies; read it again for the types.
  var out = s94_try_(function () {
    var r = UrlFetchApp.fetchAll([s94_getRequest_(S94_REDIRECT_URL)])[0];
    return { from: 's3-again', headerTypes: s94_types_(r.getAllHeaders()) };
  });
  batches.push(out);
  // httpbin echoes each repeated query parameter as its own response header.
  batches.push(s94_try_(function () {
    var r = UrlFetchApp.fetchAll([
      s94_getRequest_('https://httpbin.org/response-headers?X-S94-Rep=a&X-S94-Rep=b&Set-Cookie=s94a%3D1&Set-Cookie=s94b%3D2')
    ])[0];
    var headers = r.getAllHeaders();
    return {
      from: 'httpbin-repeated',
      status: r.getResponseCode(),
      headerTypes: s94_types_(headers),
      repeated: s94_find_(headers, 'x-s94-rep'),
      setCookie: s94_find_(headers, 'set-cookie')
    };
  }));
  return batches;
}

/** S5: elapsed ms of a batch of 5 of S1's request. */
function s94_s5_() {
  var runs = [];
  for (var i = 0; i < 3; i++) {
    var started = Date.now();
    var responses = UrlFetchApp.fetchAll([
      s94_jevRequest_(), s94_jevRequest_(), s94_jevRequest_(), s94_jevRequest_(), s94_jevRequest_()
    ]);
    runs.push({
      elapsedMs: Date.now() - started,
      statuses: responses.map(function (r) { return r.getResponseCode(); })
    });
  }
  return runs;
}

function s94_describe_(r) {
  var headers = r.getAllHeaders();
  var contentType = s94_find_(headers, 'content-type');
  var body = r.getContentText('UTF-8');
  return {
    status: r.getResponseCode(),
    headerNames: Object.keys(headers),
    headerTypes: s94_types_(headers),
    contentType: contentType === undefined ? undefined : String(contentType),
    hasRequestId: s94_find_(headers, 'x-typesafe-request-id') !== undefined,
    body: s94_scrub_(body).slice(0, 600)
  };
}

/** Name → value type ('string' or 'array') for every header. */
function s94_types_(headers) {
  var out = {};
  Object.keys(headers).forEach(function (k) {
    out[k] = Array.isArray(headers[k]) ? 'array(' + headers[k].length + ')' : typeof headers[k];
  });
  return out;
}

function s94_find_(headers, name) {
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === name) {
      return headers[keys[i]];
    }
  }
  return undefined;
}

/** Replaces UUIDs, long hex or base64-ish tokens and email addresses with <id>. */
function s94_scrub_(text) {
  return String(text)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<id>')
    .replace(/\b(?:req|request)_[A-Za-z0-9]+/g, '<id>')
    .replace(/\b[0-9a-f]{24,}\b/gi, '<id>');
}

function s94_try_(fn) {
  try {
    return fn();
  } catch (e) {
    return {
      threw: true,
      errorName: e && e.name,
      message: s94_scrub_(e && e.message !== undefined ? e.message : String(e))
    };
  }
}
