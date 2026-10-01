/**
 * The alert mailer: the `AlertSink` that sends a run's collected alerts by
 * email, at most once per condition per day (Solution Design §10.5 "Alerts";
 * epic #15 decision 10). It also holds the `state.alerts` store.
 *
 * It ties together the once-a-day rule (`src/core/alert-limit.ts`), the email
 * text (`src/core/alert-email.ts`), the owner's address (`getProfile`) and
 * `MailPort`. It compares no days and builds no text itself.
 *
 * - **Only a sent email is recorded.** A condition that couldn't be mailed
 *   stays due: the next run that raises it tries again.
 * - **Nothing is carried over.** The `errored` email lists the threads of the
 *   run that sends it. There is no pending list in state.
 * - **Expected failures are logged, not thrown** (`alert.failed`). A
 *   `StateError` (a corrupt `state.alerts`, or a failed write) and an
 *   `UnexpectedResponseError` (from `getProfile` or `send`) propagate to
 *   `runEntry`'s `finally` step, which logs them and leaves the run's outcome
 *   as it was. A corrupt `state.alerts` is never reset or overwritten.
 * - **The log never holds** the owner's address, or an email's subject or body.
 * - **No retry and no sleep.**
 *
 * **Not for `uninstall`.** The sink writes `state.alerts`, and `uninstall` has
 * just deleted every `state.*` key when `deliver` runs (`AlertSink`,
 * `src/app/alerts.ts`). The sink doesn't know its entry: the composition root
 * chooses the sink per entry.
 */
import type { AlertCondition } from '../core/alert-condition.ts';
import { buildAlertEmail } from '../core/alert-email.ts';
import {
  type AlertRecord,
  ALERTS_KEY,
  decodeAlertRecord,
  dueAlerts,
  encodeAlertRecord,
  markAlertSent,
} from '../core/alert-limit.ts';
import type { DeclaredScope } from '../core/declared-scopes.ts';
import type { LogFields } from '../core/log-fields.ts';
import { dayInTimeZone } from '../core/token-budget.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailPort } from '../ports/gmail-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { MailPort } from '../ports/mail-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import type { AlertSink, CollectedAlerts } from './alerts.ts';

export type MailAlertSinkDeps = {
  readonly mail: MailPort;
  /** The **uncounted** port: `runEntry` saved the Gmail tally before it delivers. */
  readonly gmail: Pick<GmailPort, 'getProfile'>;
  readonly state: StatePort;
  readonly clock: ClockPort;
  readonly log: LogPort;
};

/** Why an email wasn't sent. `no_owner`: the owner's address couldn't be read. */
export type AlertFailureReason = 'scope' | 'quota' | 'no_owner';

/** `alert.failed`'s `errorMessage` is cut to this many UTF-16 code units. */
export const ALERT_ERROR_MESSAGE_MAX_CHARS = 500;

const SEND_MAIL: DeclaredScope = 'https://www.googleapis.com/auth/script.send_mail';
const GMAIL_MODIFY: DeclaredScope = 'https://www.googleapis.com/auth/gmail.modify';

/** `state.alerts`, or `undefined` when the key is absent. Throws `StateError` for a value that doesn't decode; never resets it. */
export function loadAlertRecord(state: StatePort): AlertRecord | undefined {
  const raw = state.get(ALERTS_KEY);
  return raw === undefined ? undefined : decodeAlertRecord(raw);
}

/** Writes `state.alerts`. A `StateError` from the port propagates. */
export function saveAlertRecord(state: StatePort, record: AlertRecord): void {
  state.set(ALERTS_KEY, encodeAlertRecord(record));
}

/**
 * The sink that emails the owner. `deliver`:
 *
 * 1. No condition: return. Nothing is read, called, written or logged.
 * 2. The conditions due today (`dueAlerts` over `state.alerts`). None: return.
 * 3. The preflight reported `script.send_mail` missing: `alert.failed`
 *    (`reason: 'scope'`), with no mail call and no Gmail call. In a trigger
 *    run, calling a service the user didn't authorize can end the execution
 *    (SD §9).
 * 4. The preflight reported `gmail.modify` missing: `alert.failed`
 *    (`reason: 'no_owner'`, `kind: 'scope'`), with no Gmail call.
 * 5. One `getProfile` for the owner's address. A failure: `alert.failed`
 *    (`reason: 'no_owner'`, `kind`).
 * 6. One email per due condition, in order. Sent: record it, save
 *    `state.alerts` at once (a crash can then resend one email at most), and
 *    log `alert.sent`. `scope` or `quota`: `alert.failed` for this condition
 *    and the ones after it, and stop.
 *
 * `alert.failed` is logged at most once per `deliver`.
 */
export function createMailAlertSink(deps: MailAlertSinkDeps): AlertSink {
  const { mail, gmail, state, clock, log } = deps;

  const failed = (
    conditions: readonly AlertCondition[],
    reason: AlertFailureReason,
    details: { readonly kind?: string; readonly message?: string } = {},
  ): void => {
    const fields: Record<string, LogFields[string]> = { conditions: [...conditions], reason };
    if (details.kind !== undefined) fields['kind'] = details.kind;
    if (details.message !== undefined) {
      fields['errorMessage'] = details.message.slice(0, ALERT_ERROR_MESSAGE_MAX_CHARS);
    }
    log.warn('alert.failed', fields);
  };

  const deliver = (alerts: CollectedAlerts): void => {
    if (alerts.conditions.length === 0) return;

    const timeZone = clock.timeZone();
    const today = dayInTimeZone(clock.now(), timeZone);
    let record = loadAlertRecord(state);
    const due = dueAlerts(record, alerts.conditions, today);
    if (due.length === 0) return;

    if (alerts.missingScopes.includes(SEND_MAIL)) {
      failed(due, 'scope');
      return;
    }
    if (alerts.missingScopes.includes(GMAIL_MODIFY)) {
      failed(due, 'no_owner', { kind: 'scope' });
      return;
    }
    const profile = gmail.getProfile();
    if (!profile.ok) {
      failed(due, 'no_owner', { kind: profile.kind, message: profile.message });
      return;
    }

    for (const [index, condition] of due.entries()) {
      const email = buildAlertEmail({
        condition,
        ownerAddress: profile.emailAddress,
        day: today,
        timeZone,
        erroredThreadIds: alerts.erroredThreadIds,
        missingScopes: alerts.missingScopes,
        ...(alerts.consecutiveFailures === undefined
          ? {}
          : { consecutiveFailures: alerts.consecutiveFailures }),
      });
      const sent = mail.send(profile.emailAddress, email.subject, email.body);
      if (!sent.ok) {
        failed(due.slice(index), sent.kind, { message: sent.message });
        return;
      }
      record = markAlertSent(record, condition, today);
      saveAlertRecord(state, record);
      log.info('alert.sent', {
        condition,
        day: today,
        ...(condition === 'errored' ? { threads: alerts.erroredThreadIds.length } : {}),
      });
    }
  };

  return { deliver };
}
