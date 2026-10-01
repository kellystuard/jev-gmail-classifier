/**
 * Spike for E8 (#287): how does Gmail reject a bad `threads.list` page token,
 * and does a token survive between executions (a manual job keeps one in
 * `state.manual`)?
 *
 * READ-ONLY: only `Gmail.Users.Threads.list('me', ...)` and Script Properties
 * under the `s287.` prefix. Results hold counts, booleans, lengths and error
 * shapes only: no mail content, no address, no token value.
 *
 * Runnable functions (prefixed s287_, one optional args object):
 *   s287_start    lists page 1 and page 2, saves the token under s287.saved.
 *   s287_garbage  lists with garbage and foreign tokens.
 *   s287_check    lists with the saved token (refuses under 10 minutes).
 *   s287_cleanup  deletes the s287. properties.
 */

function s287_start(args) {
  args = args || {};
  var q = args.q || 'in:anywhere';
  var maxResults = args.maxResults || 5;
  var p1 = Gmail.Users.Threads.list('me', { q: q, maxResults: maxResults, includeSpamTrash: true });
  var ids1 = (p1.threads || []).map(function (t) { return t.id; });
  var token = p1.nextPageToken || null;
  var result = { q: q, maxResults: maxResults, page1Count: ids1.length, hasNextPageToken: !!token };
  if (token) {
    var p2 = Gmail.Users.Threads.list('me', { q: q, maxResults: maxResults, includeSpamTrash: true, pageToken: token });
    var ids2 = (p2.threads || []).map(function (t) { return t.id; });
    result.page2Count = ids2.length;
    result.page2HasNext = !!p2.nextPageToken;
    result.tokenLength = token.length;
    result.tokenAllDigits = /^[0-9]+$/.test(token);
    result.tokenMatchesPrintableAscii = /^[!#-[\]-~]+$/.test(token);
    var asDec = null;
    if (result.tokenAllDigits) {
      try { asDec = BigInt(token); } catch (e) { asDec = null; }
    }
    result.tokenEqualsPage1ThreadIdAsHex = false;
    ids1.forEach(function (id) {
      try { if (asDec !== null && BigInt('0x' + id) === asDec) result.tokenEqualsPage1ThreadIdAsHex = true; } catch (e) { /* not hex */ }
    });
    PropertiesService.getScriptProperties().setProperty('s287.saved', JSON.stringify({
      savedAt: Date.now(), q: q, maxResults: maxResults, token: token, page2Ids: ids2, page1Ids: ids1
    }));
  }
  return s287_out_(result);
}

function s287_garbage(args) {
  args = args || {};
  var q = args.q || 'in:anywhere';
  var maxResults = args.maxResults || 5;
  var saved = s287_load_();
  var p1 = Gmail.Users.Threads.list('me', { q: q, maxResults: maxResults, includeSpamTrash: true });
  var ids1 = (p1.threads || []).map(function (t) { return t.id; });
  var ids2 = saved ? saved.page2Ids : [];
  var cases = [
    { name: 'not-a-token', token: 'not-a-token', q: q },
    { name: '0', token: '0', q: q },
    { name: '99999999999999999999', token: '99999999999999999999', q: q },
    { name: 'empty-string', token: '', q: q }
  ];
  if (saved) cases.push({ name: 'real-token-other-q', token: saved.token, q: 'in:inbox' });
  var out = cases.map(function (c) {
    var r = s287_try_({ q: c.q, maxResults: maxResults, includeSpamTrash: true, pageToken: c.token }, c.q, ids1, ids2);
    r.name = c.name;
    return r;
  });
  return s287_out_({ cases: out });
}

function s287_check(args) {
  args = args || {};
  var saved = s287_load_();
  if (!saved) return s287_out_({ error: 'nothing saved; run s287_start' });
  var ageMinutes = Math.round((Date.now() - saved.savedAt) / 600) / 100;
  if (ageMinutes < 10 && !args.force) return s287_out_({ tooEarly: true, ageMinutes: ageMinutes });
  var r = s287_try_({ q: saved.q, maxResults: saved.maxResults, includeSpamTrash: true, pageToken: saved.token }, saved.q, saved.page1Ids, saved.page2Ids);
  r.ageMinutes = ageMinutes;
  return s287_out_(r);
}

function s287_cleanup() {
  var props = PropertiesService.getScriptProperties();
  var removed = [];
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('s287.') === 0) { props.deleteProperty(k); removed.push(k); }
  });
  return s287_out_({ removed: removed });
}

function s287_load_() {
  var raw = PropertiesService.getScriptProperties().getProperty('s287.saved');
  return raw ? JSON.parse(raw) : null;
}

function s287_same_(a, b) {
  return a.length === b.length && a.every(function (x, i) { return x === b[i]; });
}

function s287_try_(params, q, ids1, ids2) {
  try {
    var p = Gmail.Users.Threads.list('me', params);
    var ids = (p.threads || []).map(function (t) { return t.id; });
    return { ok: true, count: ids.length, hasNext: !!p.nextPageToken, sameAsPage1: s287_same_(ids, ids1), sameAsPage2: s287_same_(ids, ids2), sameIdsAsWhenFresh: s287_same_(ids, ids2) };
  } catch (e) {
    var msg = String((e && e.message) || e);
    var d = e && e.details;
    return {
      ok: false,
      name: e && e.name,
      message: msg.split(q).join('<q>'),
      hasDetails: !!d,
      code: d ? d.code : null,
      detailsMessage: d && d.message ? String(d.message).split(q).join('<q>') : null,
      reasons: d && d.errors ? d.errors.map(function (x) { return x.reason; }) : [],
      messageContainsQuery: msg.indexOf(q) >= 0
    };
  }
}

function s287_out_(result) {
  console.log(JSON.stringify(result));
  return result;
}
