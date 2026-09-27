/**
 * Content script (isolated world) for leetcode.com.
 *
 * Two independent ways to notice an accepted submission:
 *
 *  1. injected.js (page world) intercepts LeetCode's /submit/ and /check/
 *     traffic and reports an "accepted" event through window.postMessage.
 *  2. After a submission, LeetCode navigates to /problems/{slug}/submissions/{id}/.
 *     We watch the URL, then poll LeetCode's GraphQL `submissionDetails` until
 *     the verdict is in. This path does not depend on LeetCode's internal
 *     endpoints, so it keeps working when those change.
 *  3. When the Submit button is clicked (or Ctrl/Cmd+Enter is pressed), we ask
 *     LeetCode's GraphQL for the newest submission on the current problem and
 *     follow it as in path 2. This covers layouts where the URL does not change.
 *
 * All paths converge on onAccepted(), which fills in anything missing via
 * GraphQL (using your existing LeetCode login), hands the submission to the
 * service worker, and shows a toast with the outcome.
 *
 * Open the DevTools console on a LeetCode tab to see "[LeetGit]" log lines.
 */
(() => {
  // If a copy from before an extension reload is still alive in this world,
  // leave it be. If it is orphaned (its chrome.runtime is gone), take over.
  const previous = window.__leetgitContent;
  if (previous && typeof previous.alive === 'function' && previous.alive()) return;
  window.__leetgitContent = { alive: () => extensionAlive() };

  const SOURCE = 'leetgit';
  const PROBLEM_RE = /^\/problems\/([^/?#]+)/;
  const SUBMISSION_URL_RE = /^\/problems\/([^/?#]+)\/submissions\/(\d+)\/?/;
  const RELOADED_MESSAGE = 'LeetGit was reloaded or updated. Refresh this tab to resume syncing.';
  const RECENT_WINDOW_S = 30 * 60; // older submissions in the URL are history browsing, not new solves
  const POLL_INTERVAL_MS = 2000;
  const POLL_MAX_MS = 5 * 60 * 1000; // judging can queue for minutes at busy times
  const LATEST_FAST_POLLS = 20; // poll the submission list every 2 s for 40 s, then every 5 s
  const LATEST_SLOW_INTERVAL_MS = 5000;
  const SUBMIT_BUTTON_SELECTOR = '[data-e2e-locator="console-submit-button"], [data-cy="submit-code-btn"]';
  // LeetCode verdict codes. Anything else means "still judging".
  const FINAL_STATUS_CODES = new Set([10, 11, 12, 13, 14, 15, 16, 20, 21, 30]);
  const ACCEPTED_STATUS_CODE = 10;

  const handled = new Set();

  function describe(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  // Logs go to the page console and to the service worker, which keeps the
  // last few hundred lines for the popup's "Copy diagnostics" button.
  const log = (...args) => {
    console.info('[LeetGit]', ...args);
    try {
      if (extensionAlive()) {
        chrome.runtime.sendMessage(
          { type: 'LOG', line: `${location.pathname} ${args.map(describe).join(' ')}` },
          () => void chrome.runtime.lastError,
        );
      }
    } catch {
      /* ignore */
    }
  };

  let version = '';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    /* ignore */
  }
  log(`content script ${version} loaded on ${location.pathname}`);

  // ---- orphan detection ------------------------------------------------------
  // When the extension is reloaded or updated, Chrome cuts this copy of the
  // script off from the extension (chrome.runtime disappears) and the service
  // worker injects a fresh copy. Each copy writes its own token on <html>; an
  // orphan that sees a foreign token knows a newer copy is handling events.
  const INSTANCE = Math.random().toString(36).slice(2);
  function claimPage() {
    try {
      if (document.documentElement) document.documentElement.dataset.leetgit = INSTANCE;
    } catch {
      /* ignore */
    }
  }
  claimPage();
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', claimPage, { once: true });
  }

  function extensionAlive() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function newerCopyPresent() {
    try {
      return document.documentElement.dataset.leetgit !== INSTANCE;
    } catch {
      return false;
    }
  }

  function friendlyError(message) {
    if (/context invalidated|receiving end does not exist|message port closed/i.test(message || '')) {
      return RELOADED_MESSAGE;
    }
    return message;
  }

  // ---- problem timer (for Notes.md) ---------------------------------------
  function currentSlug() {
    const m = location.pathname.match(PROBLEM_RE);
    return m ? m[1] : null;
  }

  function timerKey(slug) {
    return `leetgit:opened:${slug}`;
  }

  function markOpened() {
    const slug = currentSlug();
    if (!slug) return;
    try {
      if (!sessionStorage.getItem(timerKey(slug))) {
        sessionStorage.setItem(timerKey(slug), String(Date.now()));
      }
    } catch {
      /* storage unavailable */
    }
  }

  function timeTakenFor(slug) {
    try {
      const started = Number(sessionStorage.getItem(timerKey(slug)));
      return started ? Date.now() - started : null;
    } catch {
      return null;
    }
  }

  // ---- toast ---------------------------------------------------------------
  const TOAST_COLORS = { info: '#1f2937', ok: '#15803d', warn: '#b45309', error: '#b91c1c' };
  let toastEl = null;
  let toastTimer = null;

  function toast(text, kind = 'info', { href, label, ms = 7000 } = {}) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'leetgit-toast';
      Object.assign(toastEl.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        maxWidth: '360px',
        padding: '10px 14px',
        borderRadius: '8px',
        color: '#fff',
        font: '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,.25)',
        transition: 'opacity .3s',
        pointerEvents: 'auto',
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = label || 'Open';
      Object.assign(a.style, { color: '#fff', marginLeft: '8px', textDecoration: 'underline' });
      toastEl.appendChild(a);
    }
    toastEl.style.background = TOAST_COLORS[kind] || TOAST_COLORS.info;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = '0';
    }, ms);
  }

  // ---- LeetCode GraphQL ----------------------------------------------------
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // LeetCode's clock, derived from its Date response header, so the "recent
  // submission" check does not depend on this computer's clock being right.
  let serverOffsetMs = 0;
  const serverNowS = () => (Date.now() + serverOffsetMs) / 1000;

  async function graphql(query, variables) {
    const res = await fetch('https://leetcode.com/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrftoken': getCookie('csrftoken') },
      body: JSON.stringify({ query, variables }),
    });
    try {
      const serverTime = Date.parse(res.headers.get('date') || '');
      if (!Number.isNaN(serverTime)) serverOffsetMs = serverTime - Date.now();
    } catch {
      /* ignore */
    }
    if (!res.ok) throw new Error(`LeetCode API responded with HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error(json.errors[0].message || 'LeetCode API error');
    }
    return json.data;
  }

  async function fetchQuestion(titleSlug) {
    const data = await graphql(
      `query questionData($titleSlug: String!) {
        question(titleSlug: $titleSlug) {
          questionId
          questionFrontendId
          title
          titleSlug
          difficulty
          content
        }
      }`,
      { titleSlug },
    );
    if (!data || !data.question) throw new Error(`Problem "${titleSlug}" not found`);
    return data.question;
  }

  async function fetchSubmissionDetails(submissionId) {
    const data = await graphql(
      `query submissionDetails($submissionId: Int!) {
        submissionDetails(submissionId: $submissionId) {
          code
          statusCode
          timestamp
          runtimeDisplay
          runtimePercentile
          memoryDisplay
          memoryPercentile
          lang { name }
          question { questionId titleSlug }
        }
      }`,
      { submissionId: Number(submissionId) },
    );
    return (data && data.submissionDetails) || null;
  }

  async function fetchLatestSubmission(questionSlug) {
    const data = await graphql(
      `query latestSubmission($questionSlug: String!) {
        questionSubmissionList(questionSlug: $questionSlug, offset: 0, limit: 1) {
          submissions { id timestamp statusDisplay isPending }
        }
      }`,
      { questionSlug },
    );
    const list = data && data.questionSubmissionList && data.questionSubmissionList.submissions;
    return list && list[0] ? list[0] : null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Percentiles can lag the verdict by a moment; retry a few times for them. */
  async function fetchSubmissionDetailsWithRetry(submissionId) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      try {
        last = await fetchSubmissionDetails(submissionId);
      } catch (err) {
        log('submissionDetails failed', err.message);
        last = null;
        if (attempt === 2) throw err;
        continue;
      }
      if (last && last.code && last.runtimePercentile != null && last.memoryPercentile != null) {
        return last;
      }
    }
    return last;
  }

  // ---- extension plumbing ---------------------------------------------------
  async function getSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      return settings || {};
    } catch {
      return {};
    }
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      if (!extensionAlive()) {
        reject(new Error(RELOADED_MESSAGE));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(friendlyError(err.message)));
          else resolve(response);
        });
      } catch (err) {
        reject(new Error(friendlyError(err.message)));
      }
    });
  }

  // ---- main flow ----------------------------------------------------------------
  /**
   * submission = { submissionId, slug?, lang?, code?, runtime?, memory?,
   *                runtimePercentile?, memoryPercentile?, details? }
   * Anything missing is fetched from LeetCode.
   */
  async function onAccepted(submission) {
    const submissionId = String(submission.submissionId || '');
    if (!submissionId || handled.has(submissionId)) return;
    handled.add(submissionId);

    if (!extensionAlive()) {
      // Orphaned by an extension reload. If a fresh copy is on the page it
      // handles this event; otherwise ask for a refresh.
      if (!newerCopyPresent()) toast(RELOADED_MESSAGE, 'warn', { ms: 12000 });
      return;
    }

    const settings = await getSettings();
    if (settings.enabled === false) {
      log('sync is paused, ignoring submission', submissionId);
      return;
    }
    if (!settings.token || !settings.owner || !settings.repo) {
      log('not configured, ignoring submission', submissionId);
      toast('LeetGit is not configured. Click the extension icon to set it up.', 'warn');
      return;
    }

    log('accepted submission', submissionId, 'syncing');
    toast('Accepted! Syncing to GitHub…', 'info', { ms: 20000 });

    try {
      let { slug, code, lang, runtime, memory, runtimePercentile, memoryPercentile, details } =
        submission;

      const fill = (d) => {
        if (!d) return;
        code = code || d.code;
        lang = lang || (d.lang && d.lang.name);
        slug = slug || (d.question && d.question.titleSlug);
        runtime = runtime || d.runtimeDisplay;
        memory = memory || d.memoryDisplay;
        if (runtimePercentile == null) runtimePercentile = d.runtimePercentile;
        if (memoryPercentile == null) memoryPercentile = d.memoryPercentile;
      };
      fill(details);

      if (!code || !slug || !lang || runtimePercentile == null || memoryPercentile == null) {
        fill(await fetchSubmissionDetailsWithRetry(submissionId));
      }
      slug = slug || currentSlug();
      if (!slug) throw new Error('Could not determine which problem was submitted');
      if (!code) throw new Error('Could not retrieve the submitted code');

      const question = await fetchQuestion(slug);
      const payload = {
        submissionId,
        question,
        lang,
        code,
        runtime,
        memory,
        runtimePercentile,
        memoryPercentile,
        timeTakenMs: timeTakenFor(question.titleSlug),
      };

      const response = await sendToBackground({ type: 'SYNC_ACCEPTED', payload });
      log('sync result', response && { ok: response.ok, skipped: response.skipped, reason: response.reason, error: response.error, folder: response.folder });
      if (!response) throw new Error('No response from the extension');
      if (response.ok && response.skipped) {
        // Already synced earlier (e.g. the page was reloaded); nothing to say.
      } else if (response.ok) {
        const changed = (response.results || []).filter((r) => r.action !== 'unchanged').length;
        const msg = changed
          ? `Pushed ${response.folder} to GitHub (${changed} file${changed === 1 ? '' : 's'}).`
          : `${response.folder} is already up to date on GitHub.`;
        toast(msg, 'ok', { href: response.url, label: 'View' });
      } else if (response.reason === 'not_configured') {
        toast('LeetGit is not configured. Click the extension icon to set it up.', 'warn');
      } else if (!response.skipped) {
        throw new Error(response.error || 'Unknown error');
      }
    } catch (err) {
      log('sync failed', err);
      toast(`GitHub sync failed: ${err.message}`, 'error', { ms: 12000 });
      // Allow a retry if the result is reported again (e.g. after a re-submit).
      handled.delete(submissionId);
    }
  }

  // ---- path 1: events from injected.js ---------------------------------------
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== 'accepted') return;
    const { submissionId, result = {}, submit } = data.payload || {};
    log('accepted via network interception', submissionId);
    onAccepted({
      submissionId,
      slug: submit && submit.slug,
      code: submit && submit.code,
      lang: (submit && submit.lang) || result.lang,
      runtime: result.status_runtime,
      memory: result.status_memory,
      runtimePercentile: result.runtime_percentile,
      memoryPercentile: result.memory_percentile,
    });
  });

  // ---- path 2: submission id in the URL ------------------------------------------
  const watchedSubmissions = new Set();

  async function watchSubmission(slug, submissionId) {
    const deadline = Date.now() + POLL_MAX_MS;
    let details = null;
    while (Date.now() < deadline) {
      if (handled.has(submissionId)) return; // path 1 got there first
      try {
        details = await fetchSubmissionDetails(submissionId);
      } catch (err) {
        log('submissionDetails failed', err.message);
        details = null;
      }
      if (details && FINAL_STATUS_CODES.has(Number(details.statusCode))) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!details || !FINAL_STATUS_CODES.has(Number(details.statusCode))) {
      log('gave up waiting for a verdict on submission', submissionId);
      return;
    }
    if (Number(details.statusCode) !== ACCEPTED_STATUS_CODE) {
      log('submission', submissionId, 'not accepted (status', details.statusCode + ')');
      return;
    }
    const ageS = details.timestamp ? serverNowS() - Number(details.timestamp) : 0;
    if (ageS > RECENT_WINDOW_S) {
      log('submission', submissionId, `is ${Math.round(ageS / 60)} min old history, ignoring`);
      return;
    }
    log('accepted via submission URL', submissionId);
    onAccepted({
      submissionId,
      slug: (details.question && details.question.titleSlug) || slug,
      details,
    });
  }

  let lastPath = null;
  function checkUrl() {
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      markOpened();
    }
    const m = path.match(SUBMISSION_URL_RE);
    if (!m) return;
    const [, slug, submissionId] = m;
    if (watchedSubmissions.has(submissionId)) return;
    watchedSubmissions.add(submissionId);
    log('submission URL detected', submissionId);
    watchSubmission(slug, submissionId);
  }

  checkUrl();
  setInterval(checkUrl, 1000);
  window.addEventListener('popstate', () => setTimeout(checkUrl, 0));
  try {
    if (window.navigation) {
      window.navigation.addEventListener('navigatesuccess', () => setTimeout(checkUrl, 0));
    }
  } catch {
    /* navigation API unavailable */
  }

  // ---- path 3: Submit was pressed; follow the newest submission ---------------------
  const pollingSlugs = new Set();

  async function pollLatestSubmission(slug, sinceS) {
    if (pollingSlugs.has(slug)) return;
    pollingSlugs.add(slug);
    try {
      const deadline = Date.now() + POLL_MAX_MS;
      for (let i = 0; Date.now() < deadline; i++) {
        await sleep(i < LATEST_FAST_POLLS ? POLL_INTERVAL_MS : LATEST_SLOW_INTERVAL_MS);
        let latest = null;
        try {
          latest = await fetchLatestSubmission(slug);
        } catch (err) {
          log('submission list failed', err.message);
          continue;
        }
        if (!latest) continue;
        const id = String(latest.id);
        // Only a submission made after the trigger counts; the top entry may be old.
        if (Number(latest.timestamp) < sinceS - 120) continue;
        if (watchedSubmissions.has(id) || handled.has(id)) return; // another path has it
        watchedSubmissions.add(id);
        log('new submission found via submission list', id, latest.statusDisplay);
        watchSubmission(slug, id);
        return;
      }
      log('no new submission appeared after Submit on', slug);
    } finally {
      pollingSlugs.delete(slug);
    }
  }

  function onSubmitTriggered(how) {
    const slug = currentSlug();
    if (!slug) return;
    log(`submit triggered (${how}) on ${slug}`);
    pollLatestSubmission(slug, serverNowS());
  }

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest(SUBMIT_BUTTON_SELECTOR)) {
        onSubmitTriggered('button');
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') onSubmitTriggered('shortcut');
    },
    true,
  );
})();
