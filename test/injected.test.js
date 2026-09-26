/**
 * Loads src/injected.js into a fake page environment and replays LeetCode's
 * submit + check traffic through both fetch and XMLHttpRequest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'src', 'injected.js'), 'utf8');

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Minimal XMLHttpRequest that answers from a routing function. */
function makeFakeXHR(route) {
  return class FakeXHR {
    constructor() {
      this.listeners = {};
      this.responseType = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    addEventListener(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    }
    send(body) {
      const json = route(this.method, this.url, body);
      this.responseText = JSON.stringify(json);
      queueMicrotask(() => (this.listeners.load || []).forEach((fn) => fn.call(this)));
    }
  };
}

function bootPage({ fetchRoute, xhrRoute }) {
  const messages = [];
  const window = {};
  window.window = window;
  window.location = { origin: 'https://leetcode.com', pathname: '/problems/two-sum/' };
  window.postMessage = (msg, origin) => messages.push({ msg, origin });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init && init.method) || (input && input.method) || 'GET';
    let body = init && init.body;
    if (body == null && input instanceof Request) body = await input.clone().text();
    return jsonResponse(fetchRoute(method, url, body));
  };
  window.XMLHttpRequest = makeFakeXHR(xhrRoute || (() => ({})));
  window.Request = Request;
  window.URL = URL;
  window.Promise = Promise;
  const ctx = vm.createContext(window);
  vm.runInContext(source, ctx, { filename: 'injected.js' });
  return { window, messages };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

const SUBMIT_BODY = { lang: 'python3', question_id: '1', typed_code: 'class Solution: pass' };
const ACCEPTED = {
  state: 'SUCCESS',
  status_msg: 'Accepted',
  status_code: 10,
  status_runtime: '95 ms',
  status_memory: '29.3 MB',
  runtime_percentile: 5.15,
  memory_percentile: 7.53,
  lang: 'python3',
  question_id: '1',
  submission_id: '555',
};

test('fetch: remembers submitted code and emits one accepted event with it', async () => {
  const { window, messages } = bootPage({
    fetchRoute: (method, url) => {
      if (url.includes('/submit/')) return { submission_id: 555 };
      if (url.includes('/check/')) return ACCEPTED;
      return {};
    },
  });

  await window.fetch('/problems/two-sum/submit/', { method: 'POST', body: JSON.stringify(SUBMIT_BODY) });
  await flush();
  await window.fetch('/submissions/detail/555/check/'); // pending poll returns ACCEPTED here too
  await window.fetch('/submissions/detail/555/check/'); // duplicate poll must not re-emit
  await flush();

  assert.equal(messages.length, 1);
  const { msg, origin } = messages[0];
  assert.equal(origin, 'https://leetcode.com');
  assert.equal(msg.source, 'leetgit');
  assert.equal(msg.type, 'accepted');
  assert.equal(msg.payload.submissionId, '555');
  assert.equal(msg.payload.result.status_msg, 'Accepted');
  // Objects created inside the vm context have a different Object.prototype,
  // so compare structurally rather than with strict deepEqual.
  assert.deepEqual(JSON.parse(JSON.stringify(msg.payload.submit)), {
    slug: 'two-sum',
    lang: 'python3',
    questionId: '1',
    code: 'class Solution: pass',
  });
});

test('fetch: Request objects and absolute URLs are handled', async () => {
  const { window, messages } = bootPage({
    fetchRoute: (method, url) => (url.includes('/submit/') ? { submission_id: 777 } : ACCEPTED),
  });
  const req = new Request('https://leetcode.com/problems/two-sum/submit/', {
    method: 'POST',
    body: JSON.stringify(SUBMIT_BODY),
  });
  await window.fetch(req);
  await flush();
  await window.fetch(new URL('https://leetcode.com/submissions/detail/777/check/?x=1'));
  await flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].msg.payload.submit.code, 'class Solution: pass');
});

test('fetch: ignores pending polls, rejected submissions and "Run" interpret ids', async () => {
  const { window, messages } = bootPage({
    fetchRoute: (method, url) => {
      if (url.includes('/check/')) {
        if (url.includes('runcode_')) return ACCEPTED;
        if (url.includes('/1/')) return { state: 'PENDING' };
        if (url.includes('/2/')) return { ...ACCEPTED, status_msg: 'Wrong Answer', status_code: 11 };
      }
      return {};
    },
  });
  await window.fetch('/submissions/detail/1/check/');
  await window.fetch('/submissions/detail/2/check/');
  await window.fetch('/submissions/detail/runcode_1700000000.1_AbCd/check/');
  await window.fetch('/graphql/');
  await flush();
  assert.equal(messages.length, 0);
});

test('fetch: accepted without a seen submit still emits (submit is null)', async () => {
  const { window, messages } = bootPage({ fetchRoute: () => ACCEPTED });
  await window.fetch('/submissions/detail/555/check/');
  await flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].msg.payload.submit, null);
});

test('fetch: the original response is passed through untouched', async () => {
  const { window } = bootPage({ fetchRoute: () => ACCEPTED });
  const res = await window.fetch('/submissions/detail/555/check/');
  assert.deepEqual(await res.json(), ACCEPTED);
});

test('XMLHttpRequest: same flow through XHR', async () => {
  const { window, messages } = bootPage({
    fetchRoute: () => ({}),
    xhrRoute: (method, url) => (url.includes('/submit/') ? { submission_id: 999 } : ACCEPTED),
  });
  const submit = new window.XMLHttpRequest();
  submit.open('POST', '/problems/two-sum/submit/');
  submit.send(JSON.stringify(SUBMIT_BODY));
  await flush();
  const check = new window.XMLHttpRequest();
  check.open('GET', '/submissions/detail/999/check/');
  check.send();
  await flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].msg.payload.submissionId, '999');
  assert.equal(messages[0].msg.payload.submit.slug, 'two-sum');
});
