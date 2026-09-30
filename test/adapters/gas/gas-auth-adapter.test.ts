import { describe, expect, it } from 'vitest';

import { missingFromAuthorized } from '../../../src/adapters/gas/gas-auth-adapter.ts';
import { DECLARED_SCOPES } from '../../../src/core/declared-scopes.ts';

const [MODIFY, EXTERNAL, SCRIPTAPP, SEND_MAIL] = DECLARED_SCOPES;
const ALL: string[] = [...DECLARED_SCOPES];
const without = (...out: string[]): string[] => ALL.filter((scope) => !out.includes(scope));

describe('missingFromAuthorized', () => {
  it.each<[string, unknown, string[]]>([
    ['all four', ALL, []],
    [
      'reordered plus an undeclared scope',
      [SEND_MAIL, 'https://www.googleapis.com/auth/userinfo.email', SCRIPTAPP, MODIFY, EXTERNAL],
      [],
    ],
    ['without gmail.modify', without(MODIFY), [MODIFY]],
    ['without external_request', without(EXTERNAL), [EXTERNAL]],
    ['without scriptapp', without(SCRIPTAPP), [SCRIPTAPP]],
    ['without send_mail', without(SEND_MAIL), [SEND_MAIL]],
    ['without modify and send_mail', without(MODIFY, SEND_MAIL), [MODIFY, SEND_MAIL]],
    ['empty', [], ALL],
    ['case-changed and trailing-slash URLs', [MODIFY.toUpperCase(), `${EXTERNAL}/`], ALL],
    ['non-string entries', [null, 7, {}, ...without(SCRIPTAPP)], [SCRIPTAPP]],
    ['duplicates', [MODIFY, MODIFY], [EXTERNAL, SCRIPTAPP, SEND_MAIL]],
  ])('%s', (_name, authorized, missing) => {
    expect(missingFromAuthorized(authorized)).toEqual({ ok: true, missing });
  });

  it.each([[null], [undefined], ['scopes'], [{}]])('fails as unknown for %j', (value) => {
    expect(missingFromAuthorized(value)).toEqual({
      ok: false,
      kind: 'unknown',
      message: 'getAuthorizedScopes returned no array',
    });
  });
});
