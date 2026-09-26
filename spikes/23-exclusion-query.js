/**
 * Spike #23: the exclusion search (SD §6.4, ADR-0005).
 *
 * Builds synthetic test threads with controlled dates (Messages.insert with
 * internalDateSource 'dateHeader'), runs the exclusion search shapes through
 * Gmail.Users.Threads.list, and reports which test threads come back.
 * Findings: spikes/23-exclusion-query.md.
 *
 * Runnable functions (all return a JSON-serializable, address-free result):
 *   s23_setup([{indexWaitSeconds}])       build labels and threads T1..T9
 *   s23_runCases([{groups:["A","B",...]}]) cases A-E and G
 *   s23_lagProxy([{}])                     F1 (insert vs import indexing lag)
 *   s23_f2Arm([{force}])                   F2: save position, install poller
 *   s23_f2Send([{pollSeconds, force}])     F2: self-send one message, poll
 *   s23_f2Results()                        F2: what has been recorded
 *   s23_f2Disarm()                         F2: remove the poller trigger
 *   s23_cleanup([{clearProperties}])       trash test threads, remove trigger
 *
 * Rules (spikes/README.md): no GmailApp; only s23_ triggers and s23.*
 * properties are touched; the account's address is read at run time and
 * never returned or logged (results are scrubbed to <test-account>).
 *
 * Advanced Gmail Service argument order: path parameters in REST order
 * (userId, then id), with a request body first when the method has one,
 * e.g. Threads.get('me', id, opts) and Messages.modify(body, 'me', id).
 */

var S23_DAY_ = 86400;
var S23_ACCOUNT_ = null;

// ---------------------------------------------------------------- setup

function s23_setup(opts) {
  return s23_wrap_(function () {
    opts = s23_opts_(opts);
    var t0 = Date.now();
    var run = 'r' + Math.floor(t0 / 1000);
    var D = Math.floor(t0 / 1000) - 7200; // "day 0": two hours ago, epoch s
    // C1 instant: noon UTC four days before D (early morning Pacific), so a
    // day-rounded bound would be visible in C3.
    var S = Math.floor((D - 4 * S23_DAY_) / S23_DAY_) * S23_DAY_ + 43200;
    var X = s23_senders_(run);

    var parentName = 'Spike23-' + run;
    var labelName = parentName + '/Private Stuff';
    var parentLabel = s23_createLabel_(parentName);
    var label = s23_createLabel_(labelName);

    var day = function (d) { return D + d * S23_DAY_; };
    var specs = [
      { name: 'T1', subject: 'Spike23 T1 statement', msgs: [
        { at: day(-10), from: X.bank }, { at: day(-5), from: X.carol }, { at: day(0), from: X.carol }] },
      { name: 'T2', subject: 'Spike23 T2 lunch', msgs: [
        { at: day(-1), from: X.carol }, { at: day(0), from: X.carol }] },
      { name: 'T3', subject: 'Spike23 T3 notes', msgs: [
        { at: day(-2), from: X.carol }, { at: day(-1), from: X.carol, post: 'label' }, { at: day(0), from: X.carol }] },
      { name: 'T4', subject: 'Spike23 T4 contract draft', msgs: [
        { at: day(-3), from: X.lawyer, to: X.desk }, { at: day(-2), from: X.carol }] },
      // Split case: from:lawyer and to:desk in different messages. (subject:
      // can't differ inside one thread, because threading needs a matching
      // Subject, so the split uses to: instead.)
      { name: 'T4b', subject: 'Spike23 T4b review', msgs: [
        { at: day(-3), from: X.lawyer }, { at: day(-2), from: X.carol, to: X.desk }] },
      { name: 'T5', subject: 'Spike23 T5 question', msgs: [
        { at: day(-1), from: X.carol }, { at: day(0), from: 'ME', to: X.lawyer, labels: ['SENT'] }] },
      { name: 'T6', subject: 'Spike23 T6 bounds', msgs: [
        { at: S - 1, from: X.c1early }, { at: S, from: X.c1exact }, { at: S + 1, from: X.c1late }] },
      { name: 'T7', subject: 'Spike23 T7 received time', msgs: [
        { at: day(-10), from: X.c2, dateSource: 'receivedTime' }] },
      { name: 'T8', subject: 'Spike23 T8 trash', msgs: [
        { at: day(-2), from: X.carol }, { at: day(-1), from: X.trash, post: 'trash' }, { at: day(0), from: X.carol }] },
      { name: 'T8s', subject: 'Spike23 T8s spam', msgs: [
        { at: day(-2), from: X.carol }, { at: day(-1), from: X.spam, post: 'spam' }, { at: day(0), from: X.carol }] },
      { name: 'T9', subject: 'Spike23 T9 split', msgs: [
        { at: day(-1), from: X.alice }, { at: day(0), from: X.bank }] }
    ];

    var threads = {};
    var allMsgs = [];
    specs.forEach(function (spec) {
      var t = s23_buildThread_(spec, run, label.id);
      threads[spec.name] = t;
      t.msgs.forEach(function (m) { allMsgs.push(m); });
    });

    // Threading check: every message landed in the intended thread.
    var threading = {};
    Object.keys(threads).forEach(function (name) {
      var t = threads[name];
      var got = Gmail.Users.Threads.get('me', t.id, { format: 'minimal' });
      var ids = (got.messages || []).map(function (m) { return m.id; });
      var want = t.msgs.map(function (m) { return m.id; });
      threading[name] = {
        ok: want.every(function (id) { return ids.indexOf(id) >= 0; }) && ids.length === want.length,
        messageCount: ids.length
      };
    });

    // Wait until every message is findable by its Message-ID.
    var wait = s23_waitIndexed_(allMsgs, (opts.indexWaitSeconds || 120) * 1000);

    // Record each message's resulting internalDate (never assume it).
    Object.keys(threads).forEach(function (name) {
      var t = threads[name];
      var meta = s23_threadMeta_(t.id);
      t.msgs.forEach(function (m) {
        var got = meta.byId[m.id];
        m.internalDate = got ? got.internalDate : null;
        m.labelIds = got ? got.labelIds : null;
      });
    });

    var saved = {
      run: run, createdAt: t0, D: D, S: S,
      labelId: label.id, parentLabelId: parentLabel.id, labelName: labelName,
      threads: {}
    };
    Object.keys(threads).forEach(function (name) {
      var t = threads[name];
      saved.threads[name] = {
        id: t.id,
        msgs: t.msgs.map(function (m) { return { id: m.id, mid: m.mid, at: m.at, hdr: m.hdr }; })
      };
    });
    PropertiesService.getScriptProperties().setProperty('s23.setup', JSON.stringify(saved));
    PropertiesService.getScriptProperties().deleteProperty('s23.labelTerm');

    var summary = {};
    Object.keys(threads).forEach(function (name) {
      var t = threads[name];
      summary[name] = {
        threadId: t.id,
        threadingOk: threading[name].ok,
        messageCount: threading[name].messageCount,
        messages: t.msgs.map(function (m, i) {
          return {
            i: i,
            from: m.fromLabel,
            to: m.toLabel,
            method: 'insert/' + m.dateSource + '/' + m.form,
            post: m.post || null,
            dateHeader: new Date(m.hdr * 1000).toISOString(),
            intended: m.dateSource === 'dateHeader' ? new Date(m.at * 1000).toISOString() : 'receive time',
            internalDate: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
            internalMinusHeaderSec: m.internalDate ? Math.round(Number(m.internalDate) / 1000 - m.hdr) : null,
            labelIds: m.labelIds,
            blobError: m.blobError || undefined
          };
        })
      };
    });
    return {
      fn: 's23_setup', run: run, D: D, S: S, labelName: labelName,
      setupMs: Date.now() - t0,
      index: wait,
      threads: summary
    };
  });
}

// --------------------------------------------------------------- cases

function s23_runCases(opts) {
  return s23_wrap_(function () {
    opts = s23_opts_(opts);
    var setup = s23_loadSetup_();
    var groups = opts.groups || ['A', 'B', 'C', 'D', 'E', 'G'];
    var X = s23_senders_(setup.run);
    var ctx = { setup: setup, dates: {}, cases: [] };
    // Fresh dates from metadata, as the product would get them.
    Object.keys(setup.threads).forEach(function (name) {
      var meta = s23_threadMeta_(setup.threads[name].id);
      ctx.dates[name] = meta.dates;
    });
    var W = function (names) { return s23_window_(ctx, names); };
    var c = function (id, q, params, expectIn, expectOut, note) {
      ctx.cases.push(s23_case_(ctx, id, q, params, expectIn, expectOut, note));
      return ctx.cases[ctx.cases.length - 1];
    };
    var from = function (addr) { return 'from:' + addr.split('@')[1]; };
    var to = function (addr) { return 'to:' + addr.split('@')[1]; };
    var bank = from(X.bank);
    var props = PropertiesService.getScriptProperties();
    var labelTerm = props.getProperty('s23.labelTerm') || ('label:spike23-' + setup.run + '-private-stuff');

    if (groups.indexOf('A') >= 0) {
      c('A0', bank, {}, ['T1', 'T9'], [], 'baseline, no window: the sender term is indexed');
      c('A1', '(' + bank + ') ' + W(['T1']), {}, ['T1'], []);
      var newest = Math.floor(Math.max.apply(null, ctx.dates.T1) / 1000);
      c('A2', '(' + bank + ') after:' + (newest - S23_DAY_) + ' before:' + (newest + S23_DAY_), {},
        [], ['T1'], 'window from the newest message only');
      c('A3', '(' + bank + ') ' + W(['T1', 'T2']), {}, ['T1'], ['T2']);
    }

    if (groups.indexOf('B') >= 0) {
      var r = setup.run;
      var spellings = [
        'label:spike23-' + r + '-private-stuff',
        'label:"Spike23-' + r + '/Private Stuff"',
        'label:Spike23-' + r + '/Private-Stuff',
        'label:spike23-' + r + '/private-stuff',
        'label:Spike23-' + r + '-Private-Stuff',
        'label:' + setup.labelId
      ];
      var chosen = null;
      spellings.forEach(function (sp, i) {
        var res = c('B1.' + (i + 1), '(' + sp + ') ' + W(['T3']), {}, ['T3'], [], 'label spelling');
        if (!chosen && res.asExpected && i < 5) chosen = sp; // prefer a name form over the ID
      });
      labelTerm = chosen || labelTerm;
      props.setProperty('s23.labelTerm', labelTerm);
      c('B2', '(' + bank + ' OR ' + labelTerm + ') ' + W(['T1', 'T3']), {}, ['T1', 'T3'], []);
      c('B3', '({' + bank + ' ' + labelTerm + '}) ' + W(['T1', 'T3']), {}, ['T1', 'T3'], []);
      c('B4', '(' + bank + ' OR (' + from(X.lawyer) + ' subject:contract)) ' + W(['T1', 'T3', 'T4', 'T4b']), {},
        ['T1', 'T4'], ['T3', 'T4b']);
      c('B4b', '(' + bank + ' OR (' + from(X.lawyer) + ' ' + to(X.desk) + ')) ' + W(['T1', 'T4', 'T4b']), {},
        ['T1', 'T4'], ['T4b'], 'T4b has from:lawyer and to:desk in different messages');
      c('B5a', bank + ' OR ' + labelTerm + ' ' + W(['T1', 'T3']), {}, ['T1', 'T3'], [], 'no parentheses');
      c('B5b', '(' + bank + ' OR ' + labelTerm + ') ' + W(['T3']), {}, ['T3'], ['T1'],
        'parenthesized control; T1 matches only outside this window');
      c('B5c', bank + ' OR ' + labelTerm + ' ' + W(['T3']), {}, ['T3'], ['T1'],
        'no parentheses; T1 returned means the window bound only the last OR operand');
      c('B6', '(' + to(X.lawyer) + ') ' + W(['T5']), {}, ['T5'], [], 'SENT message');
    }

    if (groups.indexOf('C') >= 0) {
      var S = setup.S;
      var c1 = [['S-1', X.c1early], ['S', X.c1exact], ['S+1', X.c1late]];
      c1.forEach(function (m) {
        c('C1.after.' + m[0], '(' + from(m[1]) + ') after:' + S, {}, null, null, 'message at ' + m[0]);
        c('C1.before.' + m[0], '(' + from(m[1]) + ') before:' + S, {}, null, null, 'message at ' + m[0]);
      });
      var t7 = Math.floor(ctx.dates.T7[0] / 1000);
      var hdr = setup.threads.T7.msgs[0].hdr;
      c('C2.internal', '(' + from(X.c2) + ') after:' + (t7 - 3600) + ' before:' + (t7 + 3600), {}, null, null,
        'window around internalDate (receive time)');
      c('C2.header', '(' + from(X.c2) + ') after:' + (hdr - 3600) + ' before:' + (hdr + 3600), {}, null, null,
        'window around the Date header (10 days earlier)');
      var ex = '(' + from(X.c1exact) + ') ';
      c('C3.around', ex + 'after:' + (S - 10800) + ' before:' + (S + 10800), {}, ['T6'], [], 'S inside a 6 h window');
      c('C3.later', ex + 'after:' + (S + 60) + ' before:' + (S + 10800), {}, [], ['T6'],
        'same day, window starts 60 s after S');
      c('C3.earlier', ex + 'after:' + (S - 10800) + ' before:' + (S - 60), {}, [], ['T6'],
        'same day, window ends 60 s before S');
    }

    if (groups.indexOf('D') >= 0) {
      [['D1', 'T8', X.trash], ['D2', 'T8s', X.spam]].forEach(function (d) {
        var q = '(' + from(d[2]) + ') ' + W([d[1]]);
        c(d[0] + '.default', q, {}, null, null);
        c(d[0] + '.includeSpamTrash', q, { includeSpamTrash: true }, null, null);
        var full = Gmail.Users.Threads.get('me', setup.threads[d[1]].id, { format: 'full' });
        var matchId = setup.threads[d[1]].msgs[1].id;
        ctx.cases.push({
          id: d[0] + '.threadsGet',
          note: 'Threads.get format full: does it return the ' + (d[0] === 'D1' ? 'trashed' : 'spam') + ' message?',
          messageCount: (full.messages || []).length,
          matchingMessageReturned: (full.messages || []).some(function (m) { return m.id === matchId; }),
          messages: (full.messages || []).map(function (m) {
            return { isMatching: m.id === matchId, labelIds: m.labelIds, hasPayload: !!m.payload };
          })
        });
      });
    }

    if (groups.indexOf('E') >= 0) {
      c('E1.manual', '(' + from(X.alice) + ') (' + bank + ')', {}, [], ['T9'],
        'ADR-0005 manual form; not returned means the manual form leaks');
      c('E1.window', '(' + bank + ') ' + W(['T9']), {}, ['T9'], []);
      c('E2', '(' + from(X.alice) + ') -(' + bank + ')', {}, ['T9'], [],
        'returned means subtracting the exclusion in the job search is unsafe');
    }

    if (groups.indexOf('G') >= 0) {
      var EX = bank + ' OR ' + labelTerm + ' OR ' + to(X.lawyer);
      var names = ['T1', 'T3', 'T5'];
      c('G1.wide', '(' + EX + ') ' + W(names), {}, names, []);
      var per = names.map(function (n) { return '(' + W([n]) + ')'; }).join(' OR ');
      c('G1.perThread', '(' + EX + ') (' + per + ')', {}, names, []);
    }

    return { fn: 's23_runCases', run: setup.run, ranAt: new Date().toISOString(), groups: groups,
      labelTerm: labelTerm, cases: ctx.cases };
  });
}

// ----------------------------------------------------------------- F1

function s23_lagProxy(opts) {
  return s23_wrap_(function () {
    opts = s23_opts_(opts);
    var run = 'r' + Math.floor(Date.now() / 1000);
    var X = s23_senders_(run);
    var acct = s23_account_();
    var now = Math.floor(Date.now() / 1000);
    var items = [
      { method: 'insert', from: X.f1ins, args: { internalDateSource: 'receivedTime' } },
      { method: 'import', from: X.f1imp, args: { internalDateSource: 'receivedTime', neverMarkSpam: true } }
    ];
    items.forEach(function (it, i) {
      var mid = '<s23-' + run + '-F1-' + i + '@spike23.example>';
      var raw = s23_mime_({ from: it.from, to: acct, subject: 'Spike23 F1 ' + it.method, date: now, mid: mid });
      var res = s23_upload_(it.method, raw, { labelIds: ['INBOX'] }, it.args);
      it.id = res.msg.id;
      it.threadId = res.msg.threadId;
      it.form = res.form;
      it.returnedAt = Date.now();
    });
    var t0 = Date.now();
    items.forEach(function (it) {
      var m = Gmail.Users.Messages.get('me', it.id, { format: 'minimal' });
      it.internalDate = Number(m.internalDate);
      it.labelIds = m.labelIds;
      var s = Math.floor(it.internalDate / 1000);
      it.q = '(from:' + it.from.split('@')[1] + ') after:' + (s - S23_DAY_) + ' before:' + (s + S23_DAY_);
      it.polls = [];
      it.firstHitSec = null;
    });
    PropertiesService.getScriptProperties().setProperty('s23.f1',
      JSON.stringify({ run: run, threadIds: items.map(function (it) { return it.threadId; }) }));

    var schedule = opts.schedule || [0, 1, 2, 5, 10, 20, 30, 60, 120];
    schedule.forEach(function (sec) {
      var wait = t0 + sec * 1000 - Date.now();
      if (wait > 0) Utilities.sleep(wait);
      items.forEach(function (it) {
        if (it.firstHitSec !== null) return;
        var r = s23_list_(it.q, {});
        var hit = !!r.ids[it.threadId];
        it.polls.push({ atSec: Math.round((Date.now() - t0) / 100) / 10, hit: hit });
        if (hit) it.firstHitSec = Math.round((Date.now() - t0) / 100) / 10;
      });
    });
    return {
      fn: 's23_lagProxy', run: run,
      note: 't=0 is after both uploads returned; times in seconds',
      results: items.map(function (it) {
        return {
          method: it.method + '/' + it.args.internalDateSource + '/' + it.form,
          args: it.args,
          internalDateMinusReturnMs: it.internalDate - it.returnedAt,
          labelIds: it.labelIds,
          q: it.q,
          firstHitSec: it.firstHitSec,
          polls: it.polls
        };
      })
    };
  });
}

// ----------------------------------------------------------------- F2

function s23_f2Arm(opts) {
  return s23_wrap_(function () {
    opts = s23_opts_(opts);
    var st = s23_f2Load_();
    if (st && !st.done && !opts.force) {
      return { fn: 's23_f2Arm', alreadyArmed: true, token: st.token, armedAt: st.armedAt, sends: st.sends.length };
    }
    s23_f2DeleteTriggers_();
    var trig = ScriptApp.newTrigger('s23_f2Poll').timeBased().everyMinutes(1).create();
    st = {
      token: 's23f2' + Date.now().toString(36),
      armedAt: Date.now(),
      startHistoryId: String(Gmail.Users.getProfile('me').historyId),
      triggerId: trig.getUniqueId(),
      sends: [], polls: 0, errors: [], done: null
    };
    s23_f2Save_(st);
    return { fn: 's23_f2Arm', token: st.token, armedAt: new Date(st.armedAt).toISOString(),
      startHistoryId: st.startHistoryId };
  });
}

function s23_f2Send(opts) {
  return s23_wrap_(function () {
    opts = s23_opts_(opts);
    var st = s23_f2Load_();
    if (!st || st.done) return { fn: 's23_f2Send', refused: 'not armed; run s23_f2Arm first' };
    var n = st.sends.length + 1;
    if (n > 3 && !opts.force) return { fn: 's23_f2Send', refused: '3 messages already sent' };
    var last = st.sends[st.sends.length - 1];
    if (last && Date.now() - last.sentAt < 5 * 60 * 1000 && !opts.force) {
      return { fn: 's23_f2Send', refused: 'last send was under 5 minutes ago',
        waitSec: Math.ceil((last.sentAt + 5 * 60 * 1000 - Date.now()) / 1000) };
    }
    var acct = s23_account_();
    var plus = acct.replace('@', '+s23@');
    var tok = st.token + 'n' + n;
    var raw = s23_mime_({ from: acct, to: plus, subject: 'Spike23 F2 ' + tok, date: Math.floor(Date.now() / 1000) });
    var sendStartAt = Date.now();
    var sent = Gmail.Users.Messages.send({ raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8) }, 'me');
    var send = {
      n: n, tok: tok, sendStartAt: sendStartAt, sentAt: Date.now(),
      id: sent.id, threadId: sent.threadId, sendLabelIds: sent.labelIds || null,
      hist: {}, search: null, searchInbox: null, extraThreadIds: []
    };
    s23_f2Merge_(function (s) { s.sends.push(send); });

    // Poll in this execution too: tighter timing than the 1-minute trigger.
    var until = Date.now() + (opts.pollSeconds || 120) * 1000;
    var poller = { prevAt: sendStartAt };
    while (Date.now() < until) {
      s23_f2PollOnce_(poller);
      var cur = s23_f2Load_().sends[n - 1];
      if (s23_f2Complete_(cur) && cur.searchInbox) break;
      Utilities.sleep(opts.intervalMs || 2000);
    }
    return { fn: 's23_f2Send', send: s23_f2Report_(s23_f2Load_().sends[n - 1]) };
  });
}

/** Time-driven trigger handler. Polls only while a send is pending. */
function s23_f2Poll() {
  var st = s23_f2Load_();
  if (!st || st.done) { s23_f2DeleteTriggers_(); return; }
  if (Date.now() - st.armedAt > 2 * 3600 * 1000) { s23_f2Finish_('timeout'); return; }
  var end = Date.now() + 25 * 1000; // bounded: the project's daily trigger runtime is shared
  var poller = { prevAt: null };
  while (Date.now() < end) {
    var cur = s23_f2Load_();
    var pending = cur.sends.filter(function (s) {
      return !s.gaveUp && !(s23_f2Complete_(s) && s.searchInbox);
    });
    if (cur.sends.length >= 3 && cur.sends.every(s23_f2Complete_)) { s23_f2Finish_('complete'); return; }
    if (!pending.length) return;
    s23_f2PollOnce_(poller);
    s23_f2Merge_(function (s) {
      s.sends.forEach(function (x) { if (Date.now() - x.sentAt > 30 * 60 * 1000) x.gaveUp = true; });
    });
    Utilities.sleep(2000);
  }
}

function s23_f2Results() {
  return s23_wrap_(function () {
    var st = s23_f2Load_();
    if (!st) return { fn: 's23_f2Results', armed: false };
    return {
      fn: 's23_f2Results',
      token: st.token,
      armedAt: new Date(st.armedAt).toISOString(),
      done: st.done, polls: st.polls, errors: st.errors,
      triggers: ScriptApp.getProjectTriggers().filter(function (t) {
        return t.getHandlerFunction() === 's23_f2Poll';
      }).length,
      sends: st.sends.map(s23_f2Report_)
    };
  });
}

function s23_f2Disarm() {
  return s23_wrap_(function () {
    var removed = s23_f2DeleteTriggers_();
    var st = s23_f2Load_();
    if (st && !st.done) s23_f2Merge_(function (s) { s.done = 'disarmed'; s.disarmedAt = Date.now(); });
    return { fn: 's23_f2Disarm', triggersRemoved: removed };
  });
}

// ------------------------------------------------------------- cleanup

function s23_cleanup(opts) {
  return s23_wrap_(function () {
    opts = s23_opts_(opts);
    var props = PropertiesService.getScriptProperties();
    var ids = [];
    var setup = props.getProperty('s23.setup');
    if (setup) {
      var s = JSON.parse(setup);
      Object.keys(s.threads).forEach(function (n) { ids.push(s.threads[n].id); });
    }
    var f1 = props.getProperty('s23.f1');
    if (f1) ids = ids.concat(JSON.parse(f1).threadIds);
    var f2 = s23_f2Load_();
    if (f2) f2.sends.forEach(function (x) { ids.push(x.threadId); ids = ids.concat(x.extraThreadIds || []); });
    var trashed = 0, failed = 0;
    ids.filter(function (id, i) { return id && ids.indexOf(id) === i; }).forEach(function (id) {
      try { Gmail.Users.Threads.trash('me', id); trashed++; } catch (e) { failed++; }
    });
    var triggersRemoved = s23_f2DeleteTriggers_();
    if (opts.clearProperties) {
      ['s23.setup', 's23.f1', 's23.f2', 's23.labelTerm'].forEach(function (k) { props.deleteProperty(k); });
    }
    return { fn: 's23_cleanup', threadsTrashed: trashed, trashFailed: failed, triggersRemoved: triggersRemoved,
      propertiesCleared: !!opts.clearProperties };
  });
}

// ------------------------------------------------------------- helpers

function s23_senders_(run) {
  var a = function (local, name) { return local + '@' + name + '-' + run + '.example'; };
  return {
    bank: a('alerts', 'bank'), lawyer: a('counsel', 'lawyer'), alice: a('alice', 'alice'),
    carol: a('carol', 'carol'), desk: a('desk', 'desk'), trash: a('notice', 'trash'), spam: a('promo', 'spam'),
    c1early: a('early', 'c1-early'), c1exact: a('exact', 'c1-exact'), c1late: a('late', 'c1-late'),
    c2: a('old', 'c2'), f1ins: a('ins', 'f1ins'), f1imp: a('imp', 'f1imp')
  };
}

function s23_buildThread_(spec, run, labelId) {
  var acct = s23_account_();
  var t = { id: null, msgs: [] };
  var refs = [];
  spec.msgs.forEach(function (m, i) {
    var mid = '<s23-' + run + '-' + spec.name + '-' + i + '@spike23.example>';
    var from = m.from === 'ME' ? acct : m.from;
    var to = m.to === 'ME' || !m.to ? acct : m.to;
    var dateSource = m.dateSource || 'dateHeader';
    var raw = s23_mime_({ from: from, to: to, subject: spec.subject, date: m.at, mid: mid, refs: refs });
    var resource = { labelIds: m.labels || ['INBOX'] };
    if (t.id) resource.threadId = t.id;
    var res = s23_upload_('insert', raw, resource, { internalDateSource: dateSource });
    if (!t.id) t.id = res.msg.threadId;
    if (m.post === 'label') {
      Gmail.Users.Messages.modify({ addLabelIds: [labelId] }, 'me', res.msg.id);
    } else if (m.post === 'trash') {
      Gmail.Users.Messages.trash('me', res.msg.id);
    } else if (m.post === 'spam') {
      Gmail.Users.Messages.modify({ addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }, 'me', res.msg.id);
    }
    refs.push(mid);
    t.msgs.push({
      id: res.msg.id, threadId: res.msg.threadId, mid: mid, at: m.at, hdr: m.at,
      dateSource: dateSource, form: res.form, blobError: res.blobError, post: m.post,
      fromLabel: m.from === 'ME' ? '<test-account>' : from,
      toLabel: to === acct ? '<test-account>' : to
    });
  });
  return t;
}

/** Upload raw MIME via Messages.insert or Messages.import. */
function s23_upload_(method, raw, resource, args) {
  var blob = Utilities.newBlob(raw, 'message/rfc822');
  try {
    return { msg: Gmail.Users.Messages[method](resource, 'me', blob, args), form: 'blob' };
  } catch (e) {
    // Fallback: raw in the resource, no media body.
    var r2 = JSON.parse(JSON.stringify(resource));
    r2.raw = Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8);
    var msg = Gmail.Users.Messages[method](r2, 'me', null, args);
    return { msg: msg, form: 'raw', blobError: s23_scrub_(String(e && e.message)) };
  }
}

function s23_mime_(m) {
  var lines = [
    'From: ' + m.from,
    'To: ' + m.to,
    'Subject: ' + m.subject,
    'Date: ' + s23_rfcDate_(m.date)
  ];
  if (m.mid) lines.push('Message-ID: ' + m.mid);
  if (m.refs && m.refs.length) {
    lines.push('In-Reply-To: ' + m.refs[m.refs.length - 1]);
    lines.push('References: ' + m.refs.join(' '));
  }
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '',
    'Synthetic test message for spike #23. No real content.', '');
  return lines.join('\r\n');
}

/** RFC 2822 date in UTC from epoch seconds, locale-independent. */
function s23_rfcDate_(sec) {
  var d = new Date(sec * 1000);
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return days[d.getUTCDay()] + ', ' + p(d.getUTCDate()) + ' ' + mons[d.getUTCMonth()] + ' ' + d.getUTCFullYear() +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' +0000';
}

function s23_createLabel_(name) {
  var existing = (Gmail.Users.Labels.list('me').labels || []).filter(function (l) { return l.name === name; })[0];
  if (existing) return existing;
  return Gmail.Users.Labels.create({ name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, 'me');
}

function s23_waitIndexed_(msgs, limitMs) {
  var t0 = Date.now();
  var pending = msgs.slice();
  var passes = 0;
  while (pending.length && Date.now() - t0 < limitMs) {
    passes++;
    pending = pending.filter(function (m) {
      var r = Gmail.Users.Messages.list('me', { q: 'rfc822msgid:' + m.mid.replace(/[<>]/g, ''), includeSpamTrash: true });
      return !(r.messages && r.messages.length);
    });
    if (pending.length) Utilities.sleep(2000);
  }
  return { allIndexed: !pending.length, waitedMs: Date.now() - t0, passes: passes,
    notIndexed: pending.map(function (m) { return m.mid; }) };
}

function s23_threadMeta_(threadId) {
  var t = Gmail.Users.Threads.get('me', threadId, { format: 'metadata', metadataHeaders: ['Message-ID'] });
  var byId = {};
  var dates = [];
  (t.messages || []).forEach(function (m) {
    byId[m.id] = { internalDate: Number(m.internalDate), labelIds: m.labelIds };
    dates.push(Number(m.internalDate));
  });
  return { byId: byId, dates: dates };
}

/** SD §6.4 window: oldest internalDate - 1 d to newest + 1 d, epoch seconds. */
function s23_window_(ctx, names) {
  var all = [];
  names.forEach(function (n) { all = all.concat(ctx.dates[n]); });
  var lo = Math.floor(Math.min.apply(null, all) / 1000) - S23_DAY_;
  var hi = Math.floor(Math.max.apply(null, all) / 1000) + S23_DAY_;
  return 'after:' + lo + ' before:' + hi;
}

/** Threads.list, paged to the end. */
function s23_list_(q, params) {
  var args = { q: q, maxResults: 500 };
  Object.keys(params || {}).forEach(function (k) { args[k] = params[k]; });
  var ids = {}, pages = 0, total = 0, est = null, token = null;
  do {
    if (token) args.pageToken = token;
    var r = Gmail.Users.Threads.list('me', args);
    pages++;
    if (est === null) est = r.resultSizeEstimate;
    (r.threads || []).forEach(function (t) { ids[t.id] = true; total++; });
    token = r.nextPageToken;
  } while (token && pages < 50);
  return { ids: ids, pages: pages, resultSizeEstimate: est, totalThreads: total, truncated: !!token };
}

function s23_case_(ctx, id, q, params, expectIn, expectOut, note) {
  var r = s23_list_(q, params);
  var returned = Object.keys(ctx.setup.threads).filter(function (n) { return r.ids[ctx.setup.threads[n].id]; });
  var asExpected = null;
  if (expectIn || expectOut) {
    asExpected = (expectIn || []).every(function (n) { return returned.indexOf(n) >= 0; }) &&
      (expectOut || []).every(function (n) { return returned.indexOf(n) < 0; });
  }
  return {
    id: id, q: q, params: params, note: note || undefined,
    expectReturned: expectIn, expectNotReturned: expectOut,
    returned: returned, asExpected: asExpected,
    pages: r.pages, resultSizeEstimate: r.resultSizeEstimate, totalThreads: r.totalThreads,
    truncated: r.truncated || undefined
  };
}

function s23_loadSetup_() {
  var raw = PropertiesService.getScriptProperties().getProperty('s23.setup');
  if (!raw) throw new Error('No s23.setup property: run s23_setup first');
  return JSON.parse(raw);
}

// F2 state (one Script Property, read-modify-write under the script lock).

function s23_f2Load_() {
  var raw = PropertiesService.getScriptProperties().getProperty('s23.f2');
  return raw ? JSON.parse(raw) : null;
}

function s23_f2Save_(st) {
  PropertiesService.getScriptProperties().setProperty('s23.f2', JSON.stringify(st));
}

function s23_f2Merge_(mutate) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return false;
  try {
    var st = s23_f2Load_();
    if (!st) return false;
    mutate(st);
    s23_f2Save_(st);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function s23_f2Complete_(s) {
  return !!(s && s.search && Object.keys(s.hist).length);
}

/**
 * One poll: history since arm (messageAdded + labelAdded) and the exclusion
 * search per pending send. Records the earliest time each thing was seen,
 * with the previous poll's time as a lower bound.
 */
function s23_f2PollOnce_(poller) {
  var st = s23_f2Load_();
  if (!st) return;
  var at = Date.now();
  var prevAt = poller.prevAt;
  var seen = { hist: {}, search: {}, searchInbox: {}, extra: {}, internal: {} };
  var errors = [];
  try {
    var threadToSend = {};
    st.sends.forEach(function (s) {
      threadToSend[s.threadId] = s.n;
      (s.extraThreadIds || []).forEach(function (t) { threadToSend[t] = s.n; });
    });
    var token = null, pages = 0;
    do {
      var args = { startHistoryId: st.startHistoryId, historyTypes: ['messageAdded', 'labelAdded'], maxResults: 500 };
      if (token) args.pageToken = token;
      var h = Gmail.Users.History.list('me', args);
      pages++;
      (h.history || []).forEach(function (rec) {
        (rec.messagesAdded || []).forEach(function (x) {
          var n = threadToSend[x.message.threadId];
          if (!n) {
            // A delivered copy may land in another thread: match it by Subject.
            n = s23_f2SubjectSend_(x.message.id, st.token, poller);
            if (!n) return;
            threadToSend[x.message.threadId] = n;
            seen.extra[x.message.threadId] = n;
          }
          seen.hist[x.message.id] = seen.hist[x.message.id] || { n: n };
          seen.hist[x.message.id].addedLabels = x.message.labelIds || [];
        });
        (rec.labelsAdded || []).forEach(function (x) {
          var n = threadToSend[x.message.threadId];
          if (!n || (x.labelIds || []).indexOf('INBOX') < 0) return;
          seen.hist[x.message.id] = seen.hist[x.message.id] || { n: n };
          seen.hist[x.message.id].inboxLabelAdded = true;
        });
      });
      token = h.nextPageToken;
    } while (token && pages < 20);

    st.sends.forEach(function (s) {
      if (s.gaveUp || (s.search && s.searchInbox)) return;
      var w = ' after:' + (Math.floor(s.sendStartAt / 1000) - S23_DAY_) + ' before:' + (Math.floor(at / 1000) + S23_DAY_);
      var r = s23_list_('(subject:' + s.tok + ')' + w, {});
      var hits = Object.keys(r.ids);
      if (hits.length) seen.search[s.n] = true;
      hits.forEach(function (t) { if (t !== s.threadId) seen.extra[t] = s.n; });
      var ri = s23_list_('(subject:' + s.tok + ') in:inbox' + w, {});
      if (Object.keys(ri.ids).length) seen.searchInbox[s.n] = true;
    });
    Object.keys(seen.hist).forEach(function (id) {
      var known = st.sends.some(function (s) { return s.hist[id] && s.hist[id].internalDate; });
      if (!known) {
        var m = Gmail.Users.Messages.get('me', id, { format: 'minimal' });
        seen.internal[id] = { internalDate: Number(m.internalDate), labelIds: m.labelIds };
      }
    });
  } catch (e) {
    errors.push(new Date(at).toISOString() + ' ' + s23_scrub_(String(e && e.message)));
  }
  poller.prevAt = at;
  s23_f2Merge_(function (s) {
    s.polls = (s.polls || 0) + 1;
    s.errors = (s.errors || []).concat(errors).slice(-5);
    s.sends.forEach(function (x) {
      Object.keys(seen.hist).forEach(function (id) {
        var hv = seen.hist[id];
        if (hv.n !== x.n) return;
        var e = x.hist[id] || (x.hist[id] = {});
        if (!e.addedAt && hv.addedLabels) { e.addedAt = at; e.addedLowerBound = prevAt; e.addedLabels = hv.addedLabels; }
        if (!e.inboxAt && hv.inboxLabelAdded) { e.inboxAt = at; e.inboxLowerBound = prevAt; }
        if (seen.internal[id]) { e.internalDate = seen.internal[id].internalDate; e.labelIdsNow = seen.internal[id].labelIds; }
      });
      if (!x.search && seen.search[x.n]) x.search = { at: at, lowerBound: prevAt };
      if (!x.searchInbox && seen.searchInbox[x.n]) x.searchInbox = { at: at, lowerBound: prevAt };
      Object.keys(seen.extra).forEach(function (t) {
        if (seen.extra[t] === x.n && x.extraThreadIds.indexOf(t) < 0) x.extraThreadIds.push(t);
      });
    });
  });
}

/** Send number whose token is in the message's Subject, or 0. Cached per execution. */
function s23_f2SubjectSend_(id, token, poller) {
  poller.checked = poller.checked || {};
  if (id in poller.checked) return poller.checked[id];
  var n = 0;
  try {
    var m = Gmail.Users.Messages.get('me', id, { format: 'metadata', metadataHeaders: ['Subject'] });
    var subject = ((m.payload && m.payload.headers) || []).filter(function (h) {
      return String(h.name).toLowerCase() === 'subject';
    }).map(function (h) { return h.value; })[0] || '';
    var match = new RegExp(token + 'n(\\d+)').exec(subject);
    if (match) n = Number(match[1]);
  } catch (e) {
    n = 0; // deleted since, or not readable: not ours
  }
  poller.checked[id] = n;
  return n;
}

function s23_f2Report_(s) {
  var sec = function (a, b) { return a && b ? Math.round((a - b) / 100) / 10 : null; };
  var msgs = Object.keys(s.hist).map(function (id) {
    var e = s.hist[id];
    return {
      isSentMessage: id === s.id,
      addedLabels: e.addedLabels || null,
      labelIdsNow: e.labelIdsNow || null,
      internalDate: e.internalDate ? new Date(e.internalDate).toISOString() : null,
      historyAddedAfterSendSec: sec(e.addedAt, s.sendStartAt),
      historyAddedLowerBoundSec: sec(e.addedLowerBound, s.sendStartAt),
      historyAddedAfterInternalSec: sec(e.addedAt, e.internalDate),
      historyInboxAfterSendSec: sec(e.inboxAt, s.sendStartAt)
    };
  });
  var firstHist = Math.min.apply(null, Object.keys(s.hist).map(function (id) { return s.hist[id].addedAt || Infinity; }));
  var internal = Math.min.apply(null, Object.keys(s.hist).map(function (id) { return s.hist[id].internalDate || Infinity; }));
  return {
    n: s.n, tok: s.tok,
    sendStartAt: new Date(s.sendStartAt).toISOString(),
    sendCallSec: sec(s.sentAt, s.sendStartAt),
    sendLabelIds: s.sendLabelIds,
    messages: msgs,
    extraThreads: (s.extraThreadIds || []).length,
    searchAfterSendSec: s.search ? sec(s.search.at, s.sendStartAt) : null,
    searchLowerBoundSec: s.search ? sec(s.search.lowerBound, s.sendStartAt) : null,
    searchInboxAfterSendSec: s.searchInbox ? sec(s.searchInbox.at, s.sendStartAt) : null,
    searchMinusHistorySec: s.search && isFinite(firstHist) ? sec(s.search.at, firstHist) : null,
    searchAfterInternalSec: s.search && isFinite(internal) ? sec(s.search.at, internal) : null,
    gaveUp: !!s.gaveUp
  };
}

function s23_f2Finish_(why) {
  s23_f2DeleteTriggers_();
  s23_f2Merge_(function (s) { s.done = why; s.disarmedAt = Date.now(); });
}

function s23_f2DeleteTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 's23_f2Poll') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

// Plumbing: account address (never returned), scrubbing, arguments.

function s23_account_() {
  if (!S23_ACCOUNT_) S23_ACCOUNT_ = Gmail.Users.getProfile('me').emailAddress;
  return S23_ACCOUNT_;
}

function s23_scrub_(text) {
  var acct = s23_account_();
  var at = acct.lastIndexOf('@');
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var re = new RegExp(esc(acct.slice(0, at)) + '(\\+[^@\\s"]*)?@' + esc(acct.slice(at + 1)), 'gi');
  return String(text).replace(re, '<test-account>');
}

function s23_opts_(opts) {
  if (typeof opts === 'string') return opts ? JSON.parse(opts) : {};
  return opts && typeof opts === 'object' ? opts : {};
}

/** Runs fn, scrubs the result, logs it, and returns it. Errors are scrubbed too. */
function s23_wrap_(fn) {
  var result;
  try {
    result = fn();
  } catch (e) {
    throw new Error(s23_scrub_(String(e && e.stack || e)));
  }
  var json = s23_scrub_(JSON.stringify(result));
  console.log(json);
  return JSON.parse(json);
}
