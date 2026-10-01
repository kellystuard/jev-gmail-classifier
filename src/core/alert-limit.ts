/**
 * The once-a-day alert rule (Solution Design §7.3, §10.5; epic #15 decision
 * 6): the `state.alerts` codec, which conditions are due, and recording a sent
 * one. Pure: the store and the sink are `src/app/alert-mailer.ts` (#302).
 *
 * Stored as `{"v": 1, "sent": {"<condition>": "YYYY-MM-DD", ...}}`, with the
 * conditions in `ALERT_CONDITIONS` order and a never-mailed condition absent.
 * A value that can't be decoded throws `StateError` and is never reset.
 */
import { z } from 'zod';

import { ALERT_CONDITIONS, type AlertCondition } from './alert-condition.ts';
import { InvalidArgumentError } from './errors.ts';
import { defineStateCodec } from './state-codec.ts';
import type { JsonValue } from './state-types.ts';
import { isCalendarDay } from './token-budget.ts';

/** The Script Properties key. */
export const ALERTS_KEY = 'state.alerts';

export type AlertRecord = {
  /** The day (`YYYY-MM-DD`, script time zone) each condition's email was last sent. A condition never mailed is absent. */
  readonly sent: Readonly<Partial<Record<AlertCondition, string>>>;
};

const daySchema = z.string().refine(isCalendarDay, 'Expected a calendar day as YYYY-MM-DD');

const sentSchema = z.partialRecord(z.enum(ALERT_CONDITIONS), daySchema);

/** The record with `sent` in `ALERT_CONDITIONS` order and absent conditions left out. */
function buildRecord(
  sent: Readonly<Partial<Record<AlertCondition, string | undefined>>>,
): AlertRecord {
  const ordered: Partial<Record<AlertCondition, string>> = {};
  for (const condition of ALERT_CONDITIONS) {
    const day = sent[condition];
    if (day !== undefined) ordered[condition] = day;
  }
  return { sent: ordered };
}

/**
 * `decode(ALERTS_KEY, raw)` throws `StateError` `version` for an unknown `v`,
 * and `schema` for a missing `v` or a bad shape (an unknown condition, a bad
 * day, an extra key). `encode` writes `v` first.
 */
export const alertRecordCodec = defineStateCodec({
  version: 1,
  schema: z
    .strictObject({ sent: sentSchema })
    .transform((fields): AlertRecord => buildRecord(fields.sent)),
});

/** Decodes a `state.alerts` value. The caller handles an absent key. Throws `StateError`. */
export function decodeAlertRecord(raw: unknown): AlertRecord {
  return alertRecordCodec.decode(ALERTS_KEY, raw);
}

/** The JSON to store under `state.alerts`. */
export function encodeAlertRecord(record: AlertRecord): JsonValue {
  return alertRecordCodec.encode(buildRecord(record.sent));
}

function checkToday(today: string): void {
  if (!isCalendarDay(today)) {
    throw new InvalidArgumentError('today must be a calendar day as YYYY-MM-DD', {
      argument: 'today',
      reason: 'not_a_day',
    });
  }
}

/**
 * The conditions to mail now: those in `conditions` (duplicates removed, given
 * order) whose stored day isn't exactly `today`. A condition never sent, sent
 * on an older day, or stored with a later day (the clock moved back) is due.
 * Throws `InvalidArgumentError` if `today` isn't a `YYYY-MM-DD` calendar day.
 */
export function dueAlerts(
  record: AlertRecord | undefined,
  conditions: readonly AlertCondition[],
  today: string,
): AlertCondition[] {
  checkToday(today);
  const due: AlertCondition[] = [];
  for (const condition of new Set(conditions)) {
    if (record?.sent[condition] !== today) due.push(condition);
  }
  return due;
}

/**
 * A new record in which `condition` was sent on `today`, the other days kept.
 * Throws `InvalidArgumentError` if `today` isn't a `YYYY-MM-DD` calendar day.
 */
export function markAlertSent(
  record: AlertRecord | undefined,
  condition: AlertCondition,
  today: string,
): AlertRecord {
  checkToday(today);
  return buildRecord({ ...record?.sent, [condition]: today });
}
