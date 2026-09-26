/**
 * Runs in the page's MAIN world (declared in manifest.json with "world": "MAIN").
 *
 * LeetCode submits code with   POST /problems/{slug}/submit/            -> { submission_id }
 * and then polls               GET  /submissions/detail/{id}/check/     -> { state, status_msg, ... }
 *
 * We wrap fetch() and XMLHttpRequest so we can see those responses, remember the
 * code that was submitted, and hand an "accepted" event to the content script
 * (isolated world) through window.postMessage.
 */
(() => {
  if (window.__leetgitPatched) return;
  window.__leetgitPatched = true;

  const SOURCE = 'leetgit';
  const CHECK_RE = /\/submissions\/detail\/(\d+)\/check\/?(?:[?#]|$)/;
  const SUBMIT_RE = /\/problems\/([^/?#]+)\/submit\/?(?:[?#]|$)/;

  const pendingSubmits = new Map(); // submissionId -> { slug, lang, questionId, code }
  const reported = new Set();
  const log = (...args) => console.info('[LeetGit]', ...args);
  log('page script loaded: watching fetch/XHR for LeetCode submissions');

  function emit(type, payload) {
    try {
      window.postMessage({ source: SOURCE, type, payload }, location.origin);
    } catch {
      /* ignore */
    }
  }

  function rememberSubmit(url, bodyText, responseJson) {
    const match = String(url).match(SUBMIT_RE);
    const id = responseJson && responseJson.submission_id;
    if (!match || !id) return;
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      /* not JSON */
    }
    pendingSubmits.set(String(id), {
      slug: match[1],
      lang: body && body.lang,
      questionId: body && body.question_id,
      code: body && body.typed_code,
    });
    log('submit seen', { submissionId: String(id), slug: match[1], hasCode: Boolean(body && body.typed_code) });
    while (pendingSubmits.size > 20) {
      pendingSubmits.delete(pendingSubmits.keys().next().value);
    }
  }

  function handleCheck(url, json) {
    const match = String(url).match(CHECK_RE);
    if (!match || !json) return;
    const id = match[1];
    log('check seen', { submissionId: id, state: json.state, status: json.status_msg });
    if (json.state !== 'SUCCESS') return;
    const accepted = json.status_msg === 'Accepted' || json.status_code === 10;
    if (!accepted || reported.has(id)) return;
    reported.add(id);
    emit('accepted', { submissionId: id, result: json, submit: pendingSubmits.get(id) || null });
    pendingSubmits.delete(id);
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return (input && typeof input.url === 'string' && input.url) || '';
  }

  // ---- fetch -------------------------------------------------------------
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = urlOf(input);
    const isSubmit = SUBMIT_RE.test(url);
    const isCheck = CHECK_RE.test(url);
    if (!isSubmit && !isCheck) return nativeFetch.apply(this, arguments);

    let bodyPromise = Promise.resolve(null);
    if (isSubmit) {
      if (init && typeof init.body === 'string') {
        bodyPromise = Promise.resolve(init.body);
      } else if (input instanceof Request) {
        try {
          bodyPromise = input.clone().text().catch(() => null);
        } catch {
          /* body already used */
        }
      }
    }

    const responsePromise = nativeFetch.apply(this, arguments);
    responsePromise
      .then((response) =>
        response
          .clone()
          .json()
          .then((json) => {
            if (isSubmit) bodyPromise.then((body) => rememberSubmit(url, body, json));
            else handleCheck(url, json);
          }),
      )
      .catch(() => {});
    return responsePromise;
  };

  // ---- XMLHttpRequest ----------------------------------------------------
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__leetgitUrl = String(url);
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__leetgitUrl || '';
    if (SUBMIT_RE.test(url) || CHECK_RE.test(url)) {
      this.addEventListener('load', () => {
        let json = null;
        try {
          json =
            this.responseType === '' || this.responseType === 'text'
              ? JSON.parse(this.responseText)
              : this.response;
        } catch {
          /* not JSON */
        }
        if (!json) return;
        if (SUBMIT_RE.test(url)) rememberSubmit(url, typeof body === 'string' ? body : null, json);
        else handleCheck(url, json);
      });
    }
    return nativeSend.apply(this, arguments);
  };
})();
