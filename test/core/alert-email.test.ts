import { describe, expect, it } from 'vitest';
import type { AlertCondition } from '../../src/core/alert-condition.ts';
import {
  ALERT_HEADLINES,
  ALERT_MAX_THREAD_LINKS,
  ALERT_SUBJECT_PREFIX,
  buildAlertEmail,
  type AlertEmailInput,
} from '../../src/core/alert-email.ts';
import { SCOPE_FEATURES } from '../../src/core/scope-features.ts';

const OWNER = 'owner+alerts@example.com';
const ENC_OWNER = 'owner%2Balerts%40example.com';
const EXTERNAL = 'https://www.googleapis.com/auth/script.external_request';
const SCOPE_MAIL = 'https://www.googleapis.com/auth/script.send_mail';

// A new condition fails the typecheck here until it is added to ALL below.
const CONDITIONS: Record<AlertCondition, true> = {
  auth: true,
  errored: true,
  run_failures: true,
  budget_reached: true,
  scope_missing: true,
  history_expired: true,
  config_invalid: true,
};
const ALL: AlertCondition[] = [
  'auth',
  'errored',
  'run_failures',
  'budget_reached',
  'scope_missing',
  'history_expired',
  'config_invalid',
];

function input(condition: AlertCondition, extra: Partial<AlertEmailInput> = {}): AlertEmailInput {
  return {
    condition,
    ownerAddress: OWNER,
    day: '2026-10-01',
    timeZone: 'America/Chicago',
    erroredThreadIds: [],
    missingScopes: [],
    ...extra,
  };
}

const build = (condition: AlertCondition, extra: Partial<AlertEmailInput> = {}) =>
  buildAlertEmail(input(condition, extra));

const WHERE =
  'Where to look: the Apps Script Executions page, https://script.google.com/home/executions';
const FOOTER = [
  '--',
  'This alert is sent at most once a day for this condition (day 2026-10-01, time zone America/Chicago).',
  'It was sent by your own copy of Jev Gmail Classifier, an Apps Script project in your Google account.',
  'Jev Gmail Classifier is an independent project. It is not affiliated with TypeSafe AI or Google.',
].join('\n');

const join = (...parts: string[]) => parts.join('\n\n');

describe('buildAlertEmail subjects', () => {
  it('tests every condition', () => {
    expect([...ALL].sort()).toEqual(Object.keys(CONDITIONS).sort());
  });

  it.each(ALL)('%s has the prefix and its fixed headline', (condition) => {
    const { subject } = build(condition, {
      erroredThreadIds: ['abc'],
      missingScopes: ['zzz'],
      consecutiveFailures: 4,
    });
    expect(subject).toBe(`[Jev Gmail Classifier] ${ALERT_HEADLINES[condition]}`);
    expect(subject.startsWith(`${ALERT_SUBJECT_PREFIX} `)).toBe(true);
    expect(subject).not.toMatch(/[\r\n]/);
    for (const value of [OWNER, ENC_OWNER, '2026-10-01', 'America/Chicago', 'abc', 'zzz']) {
      expect(subject).not.toContain(value);
    }
  });

  it('gives seven different subjects', () => {
    expect(new Set(ALL.map((c) => build(c).subject)).size).toBe(7);
    expect(build('auth').subject).toBe('[Jev Gmail Classifier] Jev API key missing or rejected');
  });
});

describe('buildAlertEmail bodies', () => {
  it('auth', () => {
    expect(build('auth').body).toBe(
      join(
        'The Jev API key is missing, or Jev rejected it.',
        'What the classifier did: it stopped the run and marked no thread. Mail that was waiting is still waiting. Every run stops like this until the key is fixed, and the first run after the fix carries on from there.',
        'What to do: in the Apps Script editor, open Project Settings > Script Properties and set JEV_API_KEY to a valid key. If it is already set, check the key and your TypeSafe account: Jev answered 401, 402 or 403.',
        `${WHERE}\nSearch the log for: run.failed (its "reason" is missing_key or auth)`,
        FOOTER,
      ),
    );
  });

  it('errored with 2 threads', () => {
    const base = `https://mail.google.com/mail/?authuser=${ENC_OWNER}`;
    expect(build('errored', { erroredThreadIds: ['t1', 't2'] }).body).toBe(
      join(
        '2 threads got the Jev/Error label in this run. Jev could not classify them: it rejected the request (invalid, or over its size limit), or the thread failed on 3 runs.',
        `${base}#all/t1\n${base}#all/t2`,
        `All threads with the label: ${base}#label/Jev%2FError`,
        'What the classifier did: it added Jev/Error to each of them and stopped retrying them. Other mail is not affected.',
        'What to do: open each thread and decide. To retry one, remove its Jev/Error label: a later run classifies it again (labels only, it is not moved). A new reply alone does not retry it.',
        'Threads that get Jev/Error later today are not mailed again: look at the label.',
        `${WHERE}\nSearch the log for: thread.errored (its "reason", "status" and "errorType") and thread.failed`,
        FOOTER,
      ),
    );
  });

  const runFailuresTail = (first: string) =>
    join(
      first,
      'What the classifier did: each of those runs stopped early. Mail they did not get to is still waiting, and later runs try again.',
      'What to do: find the cause in the log and fix it. If you also got an alert about the API key, the configuration or a permission, fix that first: it is the likely cause. A run that did not finish was stopped by Apps Script (for example at its 6-minute limit) or by hand.',
      `${WHERE}\nSearch the log for: run.failed (its "error", "reason" and "errorMessage") and run.unfinished`,
      FOOTER,
    );

  it('run_failures with 3', () => {
    expect(build('run_failures', { consecutiveFailures: 3 }).body).toBe(
      runFailuresTail('3 runs in a row failed or did not finish.'),
    );
  });

  it('run_failures with no count', () => {
    expect(build('run_failures').body).toBe(
      runFailuresTail(
        "A run failed before the classifier could read or save its run record (state.runs), so its failures can't be counted.",
      ),
    );
  });

  it('budget_reached', () => {
    expect(build('budget_reached').body).toBe(
      join(
        "Today's token budget (dailyTokenBudget in config.yaml) is used up.",
        'What the classifier did: it stopped sending threads to Jev for today. New mail is still queued and waits. Sending starts again on the next day (time zone America/Chicago).',
        'What to do: nothing, if this is expected. To classify more mail per day, raise dailyTokenBudget in config.yaml, then build and push. A large manual run uses the same budget.',
        `${WHERE}\nSearch the log for: budget.reached (its "inputTokens" and "dailyTokenBudget")`,
        FOOTER,
      ),
    );
  });

  const scopeTail = (first: string) =>
    join(
      first,
      'What the classifier did: it carried on with what still works and skipped the rest. install and uninstall stop when a permission they need is missing.',
      'What to do: run install again from the Apps Script editor and grant every permission on the consent screen.',
      `${WHERE}\nSearch the log for: scope_missing`,
      FOOTER,
    );

  it('scope_missing with script.external_request', () => {
    expect(build('scope_missing', { missingScopes: [EXTERNAL] }).body).toBe(
      scopeTail(
        `A permission (OAuth scope) the classifier needs is not granted:\n\n- ${EXTERNAL}\n  Disabled: classification: nothing is sent to Jev; new mail is still queued`,
      ),
    );
  });

  it('scope_missing with an empty list', () => {
    expect(build('scope_missing').body).toBe(
      scopeTail(
        'The classifier could not check which permissions (OAuth scopes) are granted: the check itself failed.',
      ),
    );
  });

  it('history_expired', () => {
    expect(build('history_expired').body).toBe(
      join(
        "Gmail no longer had the change history from the classifier's last saved position. This happens when the classifier has not run for about a week or more, and sometimes sooner.",
        'What the classifier did: it is catching up by search instead. It looks for mail from one hour before its last successful run until now, oldest first, over several runs. Mail that arrives meanwhile is handled after the catch-up.',
        'What to do: nothing, in most cases. Two things are not recovered. If you removed Jev/Error from a thread during the gap, that thread is not retried. If the log has history.fallback_missed, some threads were skipped because too many arrived at once. Use a manual run for either.',
        `${WHERE}\nSearch the log for: history.expired, ingest.done (its "fallback" fields) and history.fallback_missed`,
        FOOTER,
      ),
    );
  });

  it('config_invalid', () => {
    expect(build('config_invalid').body).toBe(
      join(
        "The configuration is invalid: the deployed script's configuration failed validation, or Jev did not accept the model in jevModel.",
        'What the classifier did: it stopped the run and marked no thread. Mail that was waiting is still waiting. Every run stops like this until the configuration is fixed.',
        'What to do: fix config.yaml (for a rejected model, the jevModel value), then run npm run push, which builds and pushes.',
        `${WHERE}\nSearch the log for: run.failed (its "issues" list what is wrong; for a rejected model its "reason" is config_invalid)`,
        FOOTER,
      ),
    );
  });
});

describe('errored', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${String(i)}`);
  const links = (body: string) =>
    body.split('\n').filter((l) => l.startsWith('https://mail.google.com/') && l.includes('#all/'));

  it('says "1 thread got" for one', () => {
    expect(build('errored', { erroredThreadIds: ['a'] }).body).toMatch(
      /^1 thread got the Jev\/Error label in this run\./,
    );
  });

  it.each([
    [50, 50, undefined],
    [51, 50, 'and 1 more'],
    [120, 50, 'and 70 more'],
  ])('%i threads give %i links and %s', (n, shown, more) => {
    expect(ALERT_MAX_THREAD_LINKS).toBe(50);
    const { body } = build('errored', { erroredThreadIds: ids(n) });
    expect(links(body)).toHaveLength(shown);
    const lines = body.split('\n');
    expect(lines.filter((l) => /^and \d+ more$/.test(l))).toEqual(more ? [more] : []);
    if (more) {
      const last = links(body).length;
      expect(lines[lines.indexOf(more) - 1]).toContain(`#all/t${String(last - 1)}`);
    }
  });

  it('with no IDs says so, has no link list and keeps the label link', () => {
    const { body } = build('errored');
    expect(body).toMatch(
      /^Threads got the Jev\/Error label in this run, but the run did not report which\. Jev could not classify them/,
    );
    expect(links(body)).toHaveLength(0);
    expect(body).toContain(`#label/Jev%2FError`);
    expect(body).toContain(
      'or the thread failed on 3 runs.\n\nAll threads with the label: https://mail.google.com/',
    );
  });

  it('keeps the order, encodes the address and the IDs, and ends the label link with Jev%2FError', () => {
    const { body } = build('errored', { erroredThreadIds: ['b', 'a', 'x y/é'] });
    const found = links(body);
    expect(found.map((l) => l.split('#all/')[1])).toEqual(['b', 'a', 'x%20y%2F%C3%A9']);
    const all = body
      .split('\n')
      .filter((l) => l.startsWith('https://') || l.includes(': https://'));
    for (const line of all) expect(line).toContain(`authuser=${ENC_OWNER}`);
    const label = body.split('\n').find((l) => l.startsWith('All threads with the label: '));
    expect(label?.endsWith('#label/Jev%2FError')).toBe(true);
  });
});

describe('scope_missing', () => {
  it('gives each known scope its disables text, in order', () => {
    const { body } = build('scope_missing', { missingScopes: [SCOPE_MAIL, EXTERNAL] });
    expect(body).toContain(
      `- ${SCOPE_MAIL}\n  Disabled: ${SCOPE_FEATURES[SCOPE_MAIL].disables}\n- ${EXTERNAL}\n  Disabled: ${SCOPE_FEATURES[EXTERNAL].disables}\n\nWhat the classifier did`,
    );
  });

  it.each(['https://example.com/unknown', 'constructor', '__proto__', 'toString'])(
    '%s gets its line only',
    (scope) => {
      const { body } = build('scope_missing', { missingScopes: [scope] });
      expect(body).toContain(`granted:\n\n- ${scope}\n\nWhat the classifier did`);
      expect(body).not.toContain('Disabled:');
    },
  );
});

describe('run_failures', () => {
  it('counts 7', () => {
    expect(build('run_failures', { consecutiveFailures: 7 }).body).toMatch(/^7 runs in a row/);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 60])('%s is not counted', (n) => {
    expect(build('run_failures', { consecutiveFailures: n }).body).toMatch(
      /^A run failed before the classifier could read or save its run record/,
    );
  });
});

describe('budget_reached', () => {
  it("names the input's time zone", () => {
    expect(build('budget_reached', { timeZone: 'Asia/Tokyo' }).body).toContain(
      '(time zone Asia/Tokyo)',
    );
  });
});

describe('layout, for every condition', () => {
  it.each(ALL)('%s', (condition) => {
    const { body } = build(condition, {
      erroredThreadIds: ['a', 'b'],
      missingScopes: [EXTERNAL],
      consecutiveFailures: 2,
    });
    const lines = body.split('\n');
    expect(lines.slice(-4).join('\n')).toBe(FOOTER);
    expect(body).toContain('day 2026-10-01, time zone America/Chicago');
    expect(body).toContain(`${WHERE}\nSearch the log for: `);
    expect(lines.some((l) => l !== l.trimEnd())).toBe(false);
    expect(body).not.toContain('\n\n\n');
    expect(body.endsWith('\n')).toBe(false);
    expect(body).toMatch(/^[\n\x20-\x7E]*$/);
    expect(body).toContain('What the classifier did: ');
    expect(body).toContain('What to do: ');
  });
});

describe('privacy, for every condition', () => {
  it.each(ALL)('%s', (condition) => {
    const email = build(condition, {
      erroredThreadIds: ['THREAD_ID_MARK'],
      missingScopes: ['SCOPE_MARK'],
      consecutiveFailures: 987654,
    });
    expect(email.subject).not.toContain(OWNER);
    expect(email.body).not.toContain(OWNER);
    expect(email.body).not.toContain('owner+alerts');
    if (condition === 'errored') {
      const withAddress = email.body.split('\n').filter((l) => l.includes(ENC_OWNER));
      expect(withAddress.length).toBeGreaterThan(0);
      for (const line of withAddress)
        expect(line).toMatch(/^(All threads with the label: )?https:\/\/mail\.google\.com\//);
    } else {
      expect(email.body).not.toContain(ENC_OWNER);
    }
    if (condition !== 'errored') expect(email.body).not.toContain('THREAD_ID_MARK');
    if (condition !== 'scope_missing') expect(email.body).not.toContain('SCOPE_MARK');
    if (condition !== 'run_failures') expect(email.body).not.toContain('987654');
  });
});

describe('never throws', () => {
  it.each(ALL)('%s with empty strings, lone surrogates and long lists', (condition) => {
    const long = Array.from({ length: 5000 }, (_, i) => `id${String(i)}`);
    for (const extra of [
      { ownerAddress: '', day: '', timeZone: '' },
      { ownerAddress: '\uD800', erroredThreadIds: ['\uDC00', 'x'] },
      { erroredThreadIds: long, missingScopes: long },
    ]) {
      const email = build(condition, extra);
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.body.length).toBeGreaterThan(0);
    }
  });
});
