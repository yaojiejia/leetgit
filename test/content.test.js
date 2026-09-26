/**
 * Drives src/content.js inside a fake page: stubbed chrome.*, document,
 * location, sessionStorage and a GraphQL stub. Timers are synchronous so the
 * polling loops finish instantly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'src', 'content.js'), 'utf8');

const NOW_S = Math.floor(Date.now() / 1000);
const QUESTION = {
  questionId: '1',
  questionFrontendId: '1',
  title: 'Two Sum',
  titleSlug: 'two-sum',
  difficulty: 'Easy',
  content: '<p>x</p>\n',
};
const ACCEPTED_DETAILS = {
  code: 'class Solution: pass',
  statusCode: 10,
  timestamp: NOW_S,
  runtimeDisplay: '95 ms',
  runtimePercentile: 5.15,
  memoryDisplay: '29.3 MB',
  memoryPercentile: 7.53,
  lang: { name: 'python3' },
  question: { questionId: '1', titleSlug: 'two-sum' },
};

function bootPage({ pathname = '/problems/two-sum/', submissionDetails = () => ACCEPTED_DETAILS } = {}) {
  const sent = [];
  const graphqlCalls = [];
  const listeners = {};
  const intervals = [];

  const window = {
    addEventListener(name, fn) {
      (listeners[name] ||= []).push(fn);
    },
    postMessage() {},
  };
  window.window = window;
  window.location = { origin: 'https://leetcode.com', pathname };
  window.document = {
    documentElement: { dataset: {} },
    body: null, // no toasts in tests
    cookie: 'csrftoken=abc',
    addEventListener() {},
  };
  const store = {};
  window.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };
  window.chrome = {
    runtime: {
      id: 'ext',
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      sendMessage(msg, cb) {
        sent.push(msg);
        cb({ ok: true, folder: '1-two-sum', url: 'https://github.com/o/r/tree/main/1-two-sum', results: [] });
      },
    },
    storage: {
      local: {
        get: async () => ({ settings: { token: 't', owner: 'o', repo: 'r', branch: 'main', enabled: true } }),
      },
    },
  };
  window.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    graphqlCalls.push(body);
    let data;
    if (body.query.includes('submissionDetails(')) data = { submissionDetails: submissionDetails(body.variables) };
    else if (body.query.includes('question(')) data = { question: QUESTION };
    else data = {};
    return new Response(JSON.stringify({ data }));
  };
  window.console = { info() {}, log() {}, warn() {}, error() {}, debug() {} };
  window.setTimeout = (fn) => {
    fn();
    return 1;
  };
  window.clearTimeout = () => {};
  window.setInterval = (fn) => {
    intervals.push(fn);
    return 1;
  };

  const context = vm.createContext(window);
  vm.runInContext(source, context, { filename: 'content.js' });
  // Inside the context, `window` resolves to the context's global proxy, not to
  // the sandbox object, so page events must carry that proxy as their source.
  const innerWindow = vm.runInContext('window', context);

  return {
    window,
    sent,
    graphqlCalls,
    tick: () => intervals.forEach((fn) => fn()),
    navigate: (p) => {
      window.location.pathname = p;
      intervals.forEach((fn) => fn());
    },
    pageMessage: (payload) =>
      (listeners.message || []).forEach((fn) =>
        fn({ source: innerWindow, data: { source: 'leetgit', type: 'accepted', payload } }),
      ),
  };
}

const settle = () => new Promise((r) => setImmediate(r));
async function waitFor(pred, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await settle();
  }
  return pred();
}

test('URL path: navigating to a fresh accepted submission syncs it once', async () => {
  const page = bootPage();
  page.navigate('/problems/two-sum/submissions/555/');
  assert.ok(await waitFor(() => page.sent.length === 1), 'expected one message to the service worker');

  const msg = page.sent[0];
  assert.equal(msg.type, 'SYNC_ACCEPTED');
  assert.equal(msg.payload.submissionId, '555');
  assert.equal(msg.payload.code, 'class Solution: pass');
  assert.equal(msg.payload.lang, 'python3');
  assert.equal(msg.payload.runtime, '95 ms');
  assert.equal(msg.payload.memory, '29.3 MB');
  assert.equal(msg.payload.runtimePercentile, 5.15);
  assert.equal(msg.payload.memoryPercentile, 7.53);
  assert.equal(msg.payload.question.title, 'Two Sum');
  assert.equal(msg.payload.question.questionId, '1');

  // Later ticks on the same URL must not resend.
  page.tick();
  page.tick();
  await settle();
  assert.equal(page.sent.length, 1);
});

test('URL path: keeps polling while the verdict is pending, then syncs', async () => {
  let calls = 0;
  const page = bootPage({
    submissionDetails: () => (++calls < 3 ? null : ACCEPTED_DETAILS),
  });
  page.navigate('/problems/two-sum/submissions/556/');
  assert.ok(await waitFor(() => page.sent.length === 1));
  assert.ok(calls >= 3);
});

test('URL path: a wrong answer is not synced', async () => {
  const page = bootPage({ submissionDetails: () => ({ ...ACCEPTED_DETAILS, statusCode: 11 }) });
  page.navigate('/problems/two-sum/submissions/557/');
  await waitFor(() => page.sent.length > 0, 20);
  assert.equal(page.sent.length, 0);
});

test('URL path: viewing an old accepted submission from history is ignored', async () => {
  const page = bootPage({ submissionDetails: () => ({ ...ACCEPTED_DETAILS, timestamp: NOW_S - 3600 }) });
  page.navigate('/problems/two-sum/submissions/558/');
  await waitFor(() => page.sent.length > 0, 20);
  assert.equal(page.sent.length, 0);
});

test('URL path: a plain problem page or a non-submission URL does nothing', async () => {
  const page = bootPage();
  page.navigate('/problems/two-sum/description/');
  page.navigate('/problems/two-sum/submissions/');
  page.navigate('/problemset/');
  await waitFor(() => page.sent.length > 0, 10);
  assert.equal(page.sent.length, 0);
  assert.equal(page.graphqlCalls.length, 0);
});

test('network path: event from injected.js with the submitted code syncs without submissionDetails', async () => {
  const page = bootPage();
  page.pageMessage({
    submissionId: '600',
    result: {
      status_msg: 'Accepted',
      status_runtime: '95 ms',
      status_memory: '29.3 MB',
      runtime_percentile: 5.15,
      memory_percentile: 7.53,
      lang: 'python3',
    },
    submit: { slug: 'two-sum', lang: 'python3', questionId: '1', code: 'class Solution: pass' },
  });
  assert.ok(await waitFor(() => page.sent.length === 1));
  assert.equal(page.sent[0].payload.code, 'class Solution: pass');
  assert.equal(page.sent[0].payload.question.titleSlug, 'two-sum');
  assert.ok(page.graphqlCalls.every((c) => !c.query.includes('submissionDetails(')), 'no submissionDetails needed');
});

test('both paths for the same submission produce a single sync', async () => {
  const page = bootPage();
  page.pageMessage({ submissionId: '700', result: { status_msg: 'Accepted' }, submit: null });
  page.navigate('/problems/two-sum/submissions/700/');
  await waitFor(() => page.sent.length >= 1);
  await settle();
  await settle();
  assert.equal(page.sent.length, 1);
});
