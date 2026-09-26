import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, utf8ToBase64 } from '../src/github.js';

/** Installs a fake fetch that records calls and answers from `handler`. */
function withFetch(handler, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const { status = 200, body = {} } = handler(call);
    return new Response(JSON.stringify(body), { status });
  };
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const client = new GitHubClient({ token: 'tok', owner: 'yaojiejia', repo: 'myLeet', branch: 'main' });

test('creates a file that does not exist yet', () =>
  withFetch(
    (call) => (call.method === 'GET' ? { status: 404, body: { message: 'Not Found' } } : { body: { content: { sha: 'new' }, commit: { html_url: 'c' } } }),
    async (calls) => {
      const result = await client.upsertFile('1-two-sum/two-sum.py', 'print(1)\n', 'Time: 1 ms');
      assert.equal(result.action, 'created');
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].url, 'https://api.github.com/repos/yaojiejia/myLeet/contents/1-two-sum/two-sum.py?ref=main');
      assert.equal(calls[0].headers.Authorization, 'Bearer tok');
      assert.equal(calls[1].method, 'PUT');
      assert.deepEqual(calls[1].body, { message: 'Time: 1 ms', content: utf8ToBase64('print(1)\n'), branch: 'main' });
    },
  ));

test('updates a file whose content differs, passing the existing sha', () =>
  withFetch(
    (call) =>
      call.method === 'GET'
        ? { body: { type: 'file', sha: 'old', content: utf8ToBase64('print(0)\n').replace(/(.{20})/g, '$1\n') } }
        : { body: { content: { sha: 'new' }, commit: { html_url: 'c' } } },
    async (calls) => {
      const result = await client.upsertFile('1-two-sum/two-sum.py', 'print(1)\n', 'msg');
      assert.equal(result.action, 'updated');
      assert.equal(calls[1].body.sha, 'old');
    },
  ));

test('skips the commit when the content is identical', () =>
  withFetch(
    () => ({ body: { type: 'file', sha: 'same', content: utf8ToBase64('print(1)\n') } }),
    async (calls) => {
      const result = await client.upsertFile('1-two-sum/two-sum.py', 'print(1)\n', 'msg');
      assert.equal(result.action, 'unchanged');
      assert.equal(calls.length, 1);
    },
  ));

test('surfaces GitHub error messages with status codes', () =>
  withFetch(
    () => ({ status: 401, body: { message: 'Bad credentials' } }),
    async () => {
      await assert.rejects(client.checkAccess(), (err) => err instanceof GitHubError && err.status === 401 && /Bad credentials/.test(err.message));
    },
  ));

const REPO = { full_name: 'yaojiejia/myLeet', default_branch: 'main', private: false, permissions: { push: true } };

test('checkAccess probes write access with a dangling blob', () =>
  withFetch(
    (call) => {
      if (call.url.endsWith('/branches/main')) return { body: { name: 'main' } };
      if (call.url.endsWith('/git/blobs')) return { status: 201, body: { sha: 'blob' } };
      return { body: REPO };
    },
    async (calls) => {
      const info = await client.checkAccess();
      assert.equal(info.canPush, true);
      assert.equal(info.pushError, null);
      assert.equal(info.fullName, 'yaojiejia/myLeet');
      const probe = calls.find((c) => c.url.endsWith('/git/blobs'));
      assert.equal(probe.method, 'POST');
    },
  ));

test('checkAccess reports a read-only token even though the user owns the repo', () =>
  withFetch(
    (call) => {
      if (call.url.endsWith('/branches/main')) return { body: { name: 'main' } };
      if (call.url.endsWith('/git/blobs')) return { status: 403, body: { message: 'Resource not accessible by personal access token' } };
      return { body: REPO };
    },
    async () => {
      const info = await client.checkAccess();
      assert.equal(info.canPush, false);
      assert.match(info.pushError, /cannot write to yaojiejia\/myLeet/);
      assert.match(info.pushError, /Read and write/);
    },
  ));

test('a write rejected for token permissions explains the fix', () =>
  withFetch(
    (call) =>
      call.method === 'GET'
        ? { status: 404, body: { message: 'Not Found' } }
        : { status: 403, body: { message: 'Resource not accessible by personal access token' } },
    async () => {
      await assert.rejects(client.upsertFile('a/b.py', 'x', 'm'), (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /Resource not accessible by personal access token/);
        assert.match(err.message, /Repository access/);
        assert.match(err.message, /classic token needs the "repo" scope/);
        return true;
      });
    },
  ));
