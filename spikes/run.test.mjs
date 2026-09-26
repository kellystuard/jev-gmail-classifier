#!/usr/bin/env node
// Offline test for spikes/run.mjs's push() (#176): a race between two
// concurrent pushes against a shared Apps Script project must not silently
// lose or revert a file, and a raced write must be detected and retried.
//
//   node --test spikes/run.test.mjs
//
// Zero dependencies (node:test, node:assert); runs on Node 22 and 24. There
// is no real Apps Script project here: an in-memory fake stands in for
// projects.getContent/updateContent, and each test interleaves a second,
// concurrent push at a specific point in the first one's read-merge-write,
// by hooking the fake's getContent/putContent calls (no timers, no real
// concurrency needed: this repo has no test runner wired up yet, and the
// spikes are intentionally outside E2's tooling; see spikes/README.md).

import assert from 'node:assert/strict';
import test from 'node:test';
import { Fail, push } from './run.mjs';

const APPSSCRIPT = { name: 'appsscript', type: 'JSON', source: '{}' };
const S = { scriptId: 'fake-project' };
const noSleep = async () => {};

/** An in-memory stand-in for projects.getContent / projects.updateContent. */
function makeStore(initialFiles) {
  let files = initialFiles.map((f) => ({ ...f }));
  return {
    async getContent() {
      return files.map((f) => ({ ...f }));
    },
    async putContent(_s, next) {
      files = next.map((f) => ({ ...f }));
    },
    snapshot() {
      return new Map(files.map((f) => [f.name, f]));
    },
  };
}

test('push keeps a foreign file another push adds while this push is about to write', async () => {
  const store = makeStore([APPSSCRIPT, { name: 'b', type: 'SERVER_JS', source: 'old-b' }]);
  const mineA = [APPSSCRIPT, { name: 'a', type: 'SERVER_JS', source: 'new-a' }];
  const mineB = [APPSSCRIPT, { name: 'b', type: 'SERVER_JS', source: 'new-b' }];

  let getCalls = 0;
  const result = await push(S, {
    mine: mineB,
    sleep: noSleep,
    async getContent(s) {
      getCalls++;
      // The 2nd getContent is push's re-read right before it writes: let A's
      // whole push (adding a brand-new file) land right there.
      if (getCalls === 2) await push(S, { mine: mineA, sleep: noSleep, getContent: () => store.getContent(), putContent: (s2, f) => store.putContent(s2, f) });
      return store.getContent();
    },
    putContent: (s2, f) => store.putContent(s2, f),
  });

  assert.deepEqual(result.updated, ['b']);
  const final = store.snapshot();
  assert.equal(final.get('b').source, 'new-b');
  assert.equal(final.get('a')?.source, 'new-a', "A's concurrently added file must survive B's push");
});

test('push keeps a foreign file another push updates while this push is about to write', async () => {
  const store = makeStore([APPSSCRIPT, { name: 'a', type: 'SERVER_JS', source: 'old-a' }, { name: 'b', type: 'SERVER_JS', source: 'old-b' }]);
  const mineA = [APPSSCRIPT, { name: 'a', type: 'SERVER_JS', source: 'new-a' }];
  const mineB = [APPSSCRIPT, { name: 'b', type: 'SERVER_JS', source: 'new-b' }];

  let getCalls = 0;
  const result = await push(S, {
    mine: mineB,
    sleep: noSleep,
    async getContent(s) {
      getCalls++;
      if (getCalls === 2) await push(S, { mine: mineA, sleep: noSleep, getContent: () => store.getContent(), putContent: (s2, f) => store.putContent(s2, f) });
      return store.getContent();
    },
    putContent: (s2, f) => store.putContent(s2, f),
  });

  assert.deepEqual(result.updated, ['b']);
  const final = store.snapshot();
  assert.equal(final.get('b').source, 'new-b');
  assert.equal(final.get('a').source, 'new-a', "A's concurrently updated file must survive B's push, not be reverted to old-a");
});

test('push detects a foreign file changing between its write and its verification, and retries', async () => {
  const store = makeStore([APPSSCRIPT, { name: 'a', type: 'SERVER_JS', source: 'old-a' }, { name: 'b', type: 'SERVER_JS', source: 'old-b' }]);
  const mineA = [APPSSCRIPT, { name: 'a', type: 'SERVER_JS', source: 'new-a' }];
  const mineB = [APPSSCRIPT, { name: 'b', type: 'SERVER_JS', source: 'new-b' }];

  let putCalls = 0;
  const result = await push(S, {
    mine: mineB,
    sleep: noSleep,
    getContent: () => store.getContent(),
    async putContent(s2, files) {
      putCalls++;
      await store.putContent(s2, files);
      // Right after B's first write (before B re-reads to verify), A's whole
      // push lands and changes a file B doesn't own.
      if (putCalls === 1) await push(S, { mine: mineA, sleep: noSleep, getContent: () => store.getContent(), putContent: (s3, f) => store.putContent(s3, f) });
    },
  });

  assert.ok(result.attempts >= 2, `expected a retry after the concurrent change was detected, got attempts=${result.attempts}`);
  const final = store.snapshot();
  assert.equal(final.get('b').source, 'new-b');
  assert.equal(final.get('a').source, 'new-a');
});

test('push gives up and reports the file after repeated concurrent overwrites', async () => {
  const store = makeStore([APPSSCRIPT, { name: 'b', type: 'SERVER_JS', source: 'old-b' }]);
  const mineB = [APPSSCRIPT, { name: 'b', type: 'SERVER_JS', source: 'new-b' }];

  await assert.rejects(
    () =>
      push(S, {
        mine: mineB,
        sleep: noSleep,
        getContent: () => store.getContent(),
        async putContent(s2, files) {
          await store.putContent(s2, files);
          // A rival keeps reverting this checkout's own file right after
          // every write, forever: push must not declare success.
          const current = store.snapshot();
          current.set('b', { name: 'b', type: 'SERVER_JS', source: 'old-b' });
          await store.putContent(s2, [...current.values()]);
        },
      }),
    (err) => {
      assert.ok(err instanceof Fail);
      assert.match(err.message, /\bb\b/);
      assert.match(err.message, /4 attempts/);
      return true;
    },
  );
});

test('push does not touch the project when nothing needs to change', async () => {
  const store = makeStore([APPSSCRIPT, { name: 'b', type: 'SERVER_JS', source: 'same-b' }]);
  const mineB = [APPSSCRIPT, { name: 'b', type: 'SERVER_JS', source: 'same-b' }];

  const result = await push(S, {
    mine: mineB,
    sleep: noSleep,
    getContent: () => store.getContent(),
    async putContent() {
      assert.fail('putContent must not be called when nothing added or updated');
    },
  });

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.updated, []);
  assert.equal(result.attempts, 1);
});
