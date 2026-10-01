/**
 * The text of the alert emails (Solution Design §10.5 "The alert email
 * format"; epic #15 decision 8). One pure function builds one condition's
 * subject and plain-text body from what the run collected. The sink (#302)
 * decides when to send and to whom. Nothing here reads a clock, a port or the
 * log, and `buildAlertEmail` never throws: it runs in `runEntry`'s `finally`.
 *
 * Never in an email: a subject, sender or body of any mail, the API key,
 * `excludeQuery`, a rule's question, or a label name other than `Jev/Error`.
 * The input type has no field for them. The owner's address appears only
 * inside the two kinds of Gmail link of the `errored` email, URL-encoded.
 */
import type { AlertCondition } from './alert-condition.ts';
import { assertNever } from './assert-never.ts';
import { DECLARED_SCOPES, type DeclaredScope } from './declared-scopes.ts';
import { JEV_ERROR_LABEL } from './label-path.ts';
import { SCOPE_FEATURES } from './scope-features.ts';

/** Every alert's subject starts with this, so a Gmail filter or query can match the alerts. */
export const ALERT_SUBJECT_PREFIX = '[Jev Gmail Classifier]';

/** The `errored` email lists at most this many thread links. */
export const ALERT_MAX_THREAD_LINKS = 50;

/** The fixed headline of each condition's subject. */
export const ALERT_HEADLINES: Readonly<Record<AlertCondition, string>> = {
  auth: 'Jev API key missing or rejected',
  errored: 'Threads marked Jev/Error',
  run_failures: 'Runs are failing repeatedly',
  budget_reached: 'Daily token budget reached',
  scope_missing: 'A permission is missing',
  history_expired: 'Gmail history expired: catching up',
  config_invalid: 'Configuration is invalid',
};

export type AlertEmailInput = {
  readonly condition: AlertCondition;
  /** Used only inside the Gmail links of `errored`. */
  readonly ownerAddress: string;
  /** Today, `YYYY-MM-DD`, in the script's time zone. */
  readonly day: string;
  /** The script's time zone, such as `Etc/UTC`. */
  readonly timeZone: string;
  /** For `errored`. */
  readonly erroredThreadIds: readonly string[];
  /** For `scope_missing`: scope URLs. Empty when the check itself failed. */
  readonly missingScopes: readonly string[];
  /** For `run_failures`. Absent when the failures couldn't be counted. */
  readonly consecutiveFailures?: number;
};

export type AlertEmail = { readonly subject: string; readonly body: string };

const EXECUTIONS_URL = 'https://script.google.com/home/executions';

/** `encodeURIComponent` throws on a lone surrogate; an alert must not. */
function encode(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    return encodeURIComponent(text.replace(/[\uD800-\uDFFF]/g, '?'));
  }
}

function whereToLook(searchFor: string): string {
  return [
    `Where to look: the Apps Script Executions page, ${EXECUTIONS_URL}`,
    `Search the log for: ${searchFor}`,
  ].join('\n');
}

function footer(day: string, timeZone: string): string {
  return [
    '--',
    `This alert is sent at most once a day for this condition (day ${day}, time zone ${timeZone}).`,
    'It was sent by your own copy of Jev Gmail Classifier, an Apps Script project in your Google account.',
    'Jev Gmail Classifier is an independent project. It is not affiliated with TypeSafe AI or Google.',
  ].join('\n');
}

function erroredParagraphs(input: AlertEmailInput): string[] {
  const ids = input.erroredThreadIds;
  const n = ids.length;
  const base = `https://mail.google.com/mail/?authuser=${encode(input.ownerAddress)}`;
  const reason =
    'Jev could not classify them: it rejected the request (invalid, or over its size limit), or the thread failed on 3 runs.';
  const first =
    n === 0
      ? `Threads got the Jev/Error label in this run, but the run did not report which. ${reason}`
      : `${n === 1 ? '1 thread got' : `${String(n)} threads got`} the Jev/Error label in this run. ${reason}`;
  const paragraphs = [first];
  if (n > 0) {
    const lines = ids.slice(0, ALERT_MAX_THREAD_LINKS).map((id) => `${base}#all/${encode(id)}`);
    if (n > ALERT_MAX_THREAD_LINKS) lines.push(`and ${String(n - ALERT_MAX_THREAD_LINKS)} more`);
    paragraphs.push(lines.join('\n'));
  }
  paragraphs.push(
    `All threads with the label: ${base}#label/${encode(JEV_ERROR_LABEL)}`,
    'What the classifier did: it added Jev/Error to each of them and stopped retrying them. Other mail is not affected.',
    'What to do: open each thread and decide. To retry one, remove its Jev/Error label: a later run classifies it again (labels only, it is not moved). A new reply alone does not retry it.',
    'Threads that get Jev/Error later today are not mailed again: look at the label.',
    whereToLook('thread.errored (its "reason", "status" and "errorType") and thread.failed'),
  );
  return paragraphs;
}

function declaredScope(scope: string): DeclaredScope | undefined {
  return DECLARED_SCOPES.find((declared) => declared === scope);
}

function scopeParagraph(scopes: readonly string[]): string {
  if (scopes.length === 0) {
    return 'The classifier could not check which permissions (OAuth scopes) are granted: the check itself failed.';
  }
  const lines = ['A permission (OAuth scope) the classifier needs is not granted:', ''];
  for (const scope of scopes) {
    lines.push(`- ${scope}`);
    const known = declaredScope(scope);
    if (known !== undefined) lines.push(`  Disabled: ${SCOPE_FEATURES[known].disables}`);
  }
  return lines.join('\n');
}

function paragraphsFor(input: AlertEmailInput): string[] {
  const condition = input.condition;
  switch (condition) {
    case 'auth':
      return [
        'The Jev API key is missing, or Jev rejected it.',
        'What the classifier did: it stopped the run and marked no thread. Mail that was waiting is still waiting. Every run stops like this until the key is fixed, and the first run after the fix carries on from there.',
        'What to do: in the Apps Script editor, open Project Settings > Script Properties and set JEV_API_KEY to a valid key. If it is already set, check the key and your TypeSafe account: Jev answered 401, 402 or 403.',
        whereToLook('run.failed (its "reason" is missing_key or auth)'),
      ];
    case 'errored':
      return erroredParagraphs(input);
    case 'run_failures': {
      const count = input.consecutiveFailures;
      const first =
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 1
          ? `${String(count)} runs in a row failed or did not finish.`
          : "A run failed before the classifier could read or save its run record (state.runs), so its failures can't be counted.";
      return [
        first,
        'What the classifier did: each of those runs stopped early. Mail they did not get to is still waiting, and later runs try again.',
        'What to do: find the cause in the log and fix it. If you also got an alert about the API key, the configuration or a permission, fix that first: it is the likely cause. A run that did not finish was stopped by Apps Script (for example at its 6-minute limit) or by hand.',
        whereToLook('run.failed (its "error", "reason" and "errorMessage") and run.unfinished'),
      ];
    }
    case 'budget_reached':
      return [
        "Today's token budget (dailyTokenBudget in config.yaml) is used up.",
        `What the classifier did: it stopped sending threads to Jev for today. New mail is still queued and waits. Sending starts again on the next day (time zone ${input.timeZone}).`,
        'What to do: nothing, if this is expected. To classify more mail per day, raise dailyTokenBudget in config.yaml, then build and push. A large manual run uses the same budget.',
        whereToLook('budget.reached (its "inputTokens" and "dailyTokenBudget")'),
      ];
    case 'scope_missing':
      return [
        scopeParagraph(input.missingScopes),
        'What the classifier did: it carried on with what still works and skipped the rest. install and uninstall stop when a permission they need is missing.',
        'What to do: run install again from the Apps Script editor and grant every permission on the consent screen.',
        whereToLook('scope_missing'),
      ];
    case 'history_expired':
      return [
        "Gmail no longer had the change history from the classifier's last saved position. This happens when the classifier has not run for about a week or more, and sometimes sooner.",
        'What the classifier did: it is catching up by search instead. It looks for mail from one hour before its last successful run until now, oldest first, over several runs. Mail that arrives meanwhile is handled after the catch-up.',
        'What to do: nothing, in most cases. Two things are not recovered. If you removed Jev/Error from a thread during the gap, that thread is not retried. If the log has history.fallback_missed, some threads were skipped because too many arrived at once. Use a manual run for either.',
        whereToLook(
          'history.expired, ingest.done (its "fallback" fields) and history.fallback_missed',
        ),
      ];
    case 'config_invalid':
      return [
        "The configuration is invalid: the deployed script's configuration failed validation, or Jev did not accept the model in jevModel.",
        'What the classifier did: it stopped the run and marked no thread. Mail that was waiting is still waiting. Every run stops like this until the configuration is fixed.',
        'What to do: fix config.yaml (for a rejected model, the jevModel value), then run npm run push, which builds and pushes.',
        whereToLook(
          'run.failed (its "issues" list what is wrong; for a rejected model its "reason" is config_invalid)',
        ),
      ];
    default:
      return assertNever(condition);
  }
}

/** Builds one condition's alert email. Reads only the input fields that condition uses. */
export function buildAlertEmail(input: AlertEmailInput): AlertEmail {
  const paragraphs = [...paragraphsFor(input), footer(input.day, input.timeZone)];
  return {
    subject: `${ALERT_SUBJECT_PREFIX} ${ALERT_HEADLINES[input.condition]}`,
    body: paragraphs.join('\n\n'),
  };
}
