import { describe, expect, it } from 'vitest';

import { FakeSecrets } from './fake-secrets.ts';

describe('FakeSecrets', () => {
  it('returns the key trimmed', () => {
    expect(new FakeSecrets({ jevApiKey: '  sk-test \n' }).getJevApiKey()).toBe('sk-test');
  });

  it.each([undefined, '', '   '])('returns undefined for %j', (jevApiKey) => {
    const secrets = new FakeSecrets(jevApiKey === undefined ? {} : { jevApiKey });
    expect(secrets.getJevApiKey()).toBeUndefined();
  });

  it('can be set and cleared', () => {
    const secrets = new FakeSecrets();
    secrets.setJevApiKey('sk-new');
    expect(secrets.getJevApiKey()).toBe('sk-new');
    secrets.clear();
    expect(secrets.getJevApiKey()).toBeUndefined();
  });
});
