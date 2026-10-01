import { describe, expect, it } from 'vitest';
import {
  MAX_MAIL_FAILURE_MESSAGE_LENGTH,
  mailFailure,
} from '../../../src/adapters/gas/mail-errors.ts';
import { UnexpectedResponseError } from '../../../src/core/errors.ts';
import { MAIL_QUOTA_MESSAGE } from '../../fakes/fake-mail.ts';
import { SCOPE_ERROR_MESSAGE } from '../../fakes/fake-scopes.ts';

const RECIPIENT = 'owner@example.com';

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
}

describe('mailFailure', () => {
  const fragments = [
    'Authorization is required to perform that action',
    'insufficient authentication scopes',
    'Specified permissions are not sufficient',
  ];

  it.each(fragments.flatMap((f) => [f, f.toUpperCase()]))('maps %s to scope', (text) => {
    expect(mailFailure(new Error(`Exception: ${text}.`), RECIPIENT)).toEqual({
      ok: false,
      kind: 'scope',
      message: `Exception: ${text}.`,
    });
  });

  it('agrees with the fakes', () => {
    expect(mailFailure(new Error(SCOPE_ERROR_MESSAGE), RECIPIENT).kind).toBe('scope');
    expect(mailFailure(new Error(MAIL_QUOTA_MESSAGE), RECIPIENT).kind).toBe('quota');
  });

  it.each([
    'Service invoked too many times for one day: email.',
    'SERVICE INVOKED TOO MANY TIMES FOR ONE DAY: EMAIL.',
    'Exception: Service invoked too many times for one day: email. (line 3)',
  ])('maps %s to quota', (text) => {
    expect(mailFailure(new Error(text), RECIPIENT)).toEqual({
      ok: false,
      kind: 'quota',
      message: text,
    });
  });

  it('checks scope before quota', () => {
    const text = `insufficient authentication scopes / ${MAIL_QUOTA_MESSAGE}`;
    expect(mailFailure(new Error(text), RECIPIENT).kind).toBe('scope');
  });

  it('throws for a different rate error', () => {
    const error = thrownBy(() =>
      mailFailure(
        new Error('Service invoked too many times in a short time: gmail rateMax.'),
        RECIPIENT,
      ),
    );
    expect(error).toBeInstanceOf(UnexpectedResponseError);
  });

  it('throws a scrubbed error without a cause', () => {
    const error = thrownBy(() =>
      mailFailure(new Error('Invalid email: Owner@Example.com'), RECIPIENT),
    );
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    if (!(error instanceof UnexpectedResponseError)) {
      return;
    }
    expect(error.service).toBe('mail');
    expect(error.reason).toBe('sendEmail failed');
    expect(error.message).toBe('MailApp sendEmail failed: Invalid email: <recipient>');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error.toLogFields()).toLowerCase()).not.toContain(RECIPIENT);
  });

  it('scrubs the recipient from scope and quota messages, every occurrence', () => {
    const scope = mailFailure(
      new Error(`insufficient authentication scopes for ${RECIPIENT} and OWNER@example.com`),
      RECIPIENT,
    );
    expect(scope).toEqual({
      ok: false,
      kind: 'scope',
      message: 'insufficient authentication scopes for <recipient> and <recipient>',
    });
    const quota = mailFailure(new Error(`${MAIL_QUOTA_MESSAGE} ${RECIPIENT}`), RECIPIENT);
    expect(quota).toEqual({
      ok: false,
      kind: 'quota',
      message: `${MAIL_QUOTA_MESSAGE} <recipient>`,
    });
  });

  it('cuts long messages to 500 characters and still recognizes the text', () => {
    const failure = mailFailure(new Error(`${MAIL_QUOTA_MESSAGE}${'x'.repeat(2000)}`), RECIPIENT);
    expect(failure.kind).toBe('quota');
    expect(failure.message).toHaveLength(MAX_MAIL_FAILURE_MESSAGE_LENGTH);
    const error = thrownBy(() => mailFailure(new Error('y'.repeat(2000)), RECIPIENT));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    if (error instanceof UnexpectedResponseError) {
      expect(error.message).toBe(
        `MailApp sendEmail failed: ${'y'.repeat(MAX_MAIL_FAILURE_MESSAGE_LENGTH)}`,
      );
    }
  });

  it.each([
    ['a string', 'boom', 'boom'],
    ['undefined', undefined, 'undefined'],
    ['a non-string message', { message: 42 }, '[object Object]'],
  ])('uses the string form of %s', (_name, value, text) => {
    const error = thrownBy(() => mailFailure(value, RECIPIENT));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error instanceof Error ? error.message : '').toBe(`MailApp sendEmail failed: ${text}`);
  });

  it('scrubs nothing for an empty recipient', () => {
    const failure = mailFailure(new Error(MAIL_QUOTA_MESSAGE), '');
    expect(failure).toEqual({ ok: false, kind: 'quota', message: MAIL_QUOTA_MESSAGE });
  });
});
