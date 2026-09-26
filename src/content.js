/**
 * Content script (isolated world) for leetcode.com.
 *
 * - receives "accepted" events from injected.js (page world)
 * - fills in anything missing via LeetCode's GraphQL API (same-origin, uses the login cookie)
 * - hands the finished submission to the service worker, which commits it to GitHub
 * - shows a small toast with the outcome
 * - keeps a per-tab timer per problem for the optional Notes.md "Time taken"
 */
(() => {
  if (window.__leetgitContent) return;
  window.__leetgitContent = true;

  const SOURCE = 'leetgit';
  const PROBLEM_RE = /^\/problems\/([^/?#]+)/;
  const RELOADED_MESSAGE = 'LeetGit was reloaded or updated. Refresh this tab to resume syncing.';
  const handled = new Set();

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

  markOpened();
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      markOpened();
    }
  }, 1000);

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

  async function graphql(query, variables) {
    const res = await fetch('https://leetcode.com/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrftoken': getCookie('csrftoken') },
      body: JSON.stringify({ query, variables }),
    });
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchSubmissionDetailsWithRetry(submissionId) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      try {
        last = await fetchSubmissionDetails(submissionId);
      } catch (err) {
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
  async function onAccepted({ submissionId, result, submit }) {
    if (!submissionId || handled.has(submissionId)) return;
    handled.add(submissionId);

    if (!extensionAlive()) {
      // Orphaned by an extension reload. If a fresh copy is on the page it
      // handles this event; otherwise ask for a refresh.
      if (!newerCopyPresent()) toast(RELOADED_MESSAGE, 'warn', { ms: 12000 });
      return;
    }

    const settings = await getSettings();
    if (settings.enabled === false) return;
    if (!settings.token || !settings.owner || !settings.repo) {
      toast('LeetGit is not configured. Click the extension icon to set it up.', 'warn');
      return;
    }

    toast('Accepted! Syncing to GitHub…', 'info', { ms: 20000 });

    try {
      let slug = submit && submit.slug;
      let code = submit && submit.code;
      let lang = (submit && submit.lang) || result.lang;
      let runtime = result.status_runtime;
      let memory = result.status_memory;
      let runtimePercentile = result.runtime_percentile;
      let memoryPercentile = result.memory_percentile;

      const needDetails =
        !code || !slug || runtimePercentile == null || memoryPercentile == null;
      if (needDetails) {
        const details = await fetchSubmissionDetailsWithRetry(submissionId);
        if (details) {
          code = code || details.code;
          lang = lang || (details.lang && details.lang.name);
          slug = slug || (details.question && details.question.titleSlug);
          runtime = runtime || details.runtimeDisplay;
          memory = memory || details.memoryDisplay;
          if (runtimePercentile == null) runtimePercentile = details.runtimePercentile;
          if (memoryPercentile == null) memoryPercentile = details.memoryPercentile;
        }
      }
      slug = slug || currentSlug();
      if (!slug) throw new Error('Could not determine which problem was submitted');
      if (!code) throw new Error('Could not retrieve the submitted code');

      const question = await fetchQuestion(slug);
      const payload = {
        submissionId: String(submissionId),
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
      if (!response) throw new Error('No response from the extension');
      if (response.ok && response.skipped) {
        toast('Already synced this submission.', 'info');
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
      toast(`GitHub sync failed: ${err.message}`, 'error', { ms: 12000 });
      // Allow a retry if LeetCode re-emits the result (e.g. after a re-submit).
      handled.delete(submissionId);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === 'accepted') onAccepted(data.payload || {});
  });
})();
