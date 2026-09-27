import { type Fail, type NoFields, type Result, fail, ok } from '../../src/core/result.ts';
import type { MailPort } from '../../src/ports/mail-port.ts';
import { FakeScopes } from './fake-scopes.ts';
import { type FailNextOptions, type FakeCall, FailureQueue } from './failure-queue.ts';

type MailFailure = Fail<'scope', { message: string }> | Fail<'quota', { message: string }>;

export type SentMail = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
};

export type FakeMailOptions = {
  readonly scopes?: FakeScopes;
  /** Emails allowed before `send` returns `quota`. Unlimited when unset. */
  readonly dailyQuota?: number;
};

export const MAIL_QUOTA_MESSAGE = 'Service invoked too many times for one day: email.';

/** `MailApp.sendEmail`: records sent mail, needs `script.send_mail`, and can run out of quota. */
export class FakeMail implements MailPort {
  readonly calls: FakeCall<'send'>[] = [];
  readonly sent: SentMail[] = [];
  private readonly scopes: FakeScopes;
  private readonly dailyQuota: number | undefined;
  private readonly failures = new FailureQueue<'send', MailFailure>();

  constructor(options: FakeMailOptions = {}) {
    this.scopes = options.scopes ?? new FakeScopes();
    this.dailyQuota = options.dailyQuota;
  }

  send(to: string, subject: string, body: string): Result<NoFields, MailFailure> {
    this.calls.push({ method: 'send', args: [to, subject, body] });
    const failure =
      this.failures.take('send') ??
      this.scopes.failureFor('https://www.googleapis.com/auth/script.send_mail');
    if (failure !== undefined) {
      return failure;
    }
    if (this.dailyQuota !== undefined && this.sent.length >= this.dailyQuota) {
      return fail('quota', { message: MAIL_QUOTA_MESSAGE });
    }
    this.sent.push({ to, subject, body });
    return ok({});
  }

  failNext(method: 'send', failure: MailFailure | Error, options: FailNextOptions = {}): void {
    this.failures.add(method, failure, options);
  }
}
