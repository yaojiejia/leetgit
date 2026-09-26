/**
 * Service worker: receives accepted submissions from the content script and
 * commits them to GitHub, one file per commit, in the LeetSync layout.
 */
import { DEFAULT_SETTINGS, buildSyncPlan } from './format.js';
import { GitHubClient } from './github.js';

const HISTORY_LIMIT = 50;
const SYNCED_LIMIT = 500;

// Submissions are processed strictly one after another so two quick accepts
// never race on the same README's sha.
let queue = Promise.resolve();

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function isConfigured(s) {
  return Boolean(s.token && s.owner && s.repo && s.branch);
}

function folderUrl(settings, folder) {
  return `https://github.com/${settings.owner}/${settings.repo}/tree/${settings.branch}/${folder}`;
}

async function appendHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  // A retry replaces the earlier entry for the same submission.
  const rest = history.filter((h) => h.submissionId !== entry.submissionId);
  rest.unshift(entry);
  await chrome.storage.local.set({ history: rest.slice(0, HISTORY_LIMIT) });
}

async function markSynced(submissionId) {
  const { syncedSubmissions = {} } = await chrome.storage.local.get('syncedSubmissions');
  syncedSubmissions[submissionId] = Date.now();
  const ids = Object.keys(syncedSubmissions);
  if (ids.length > SYNCED_LIMIT) {
    ids
      .sort((a, b) => syncedSubmissions[a] - syncedSubmissions[b])
      .slice(0, ids.length - SYNCED_LIMIT)
      .forEach((id) => delete syncedSubmissions[id]);
  }
  await chrome.storage.local.set({ syncedSubmissions });
}

let badgeTimer = null;
function flashBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), 6000);
  } catch {
    /* action API unavailable */
  }
}

async function syncSubmission(payload) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, skipped: true, reason: 'disabled' };
  if (!isConfigured(settings)) {
    return { ok: false, reason: 'not_configured', error: 'Extension is not configured' };
  }

  const submissionId = String(payload.submissionId);
  const { syncedSubmissions = {} } = await chrome.storage.local.get('syncedSubmissions');
  if (syncedSubmissions[submissionId]) {
    return { ok: true, skipped: true, reason: 'already_synced' };
  }

  const { folder, files } = buildSyncPlan(payload, settings);
  const client = new GitHubClient(settings);
  const base = {
    time: Date.now(),
    submissionId,
    title: payload.question.title,
    titleSlug: payload.question.titleSlug,
    folder,
    lang: payload.lang,
    runtime: payload.runtime,
    memory: payload.memory,
    url: folderUrl(settings, folder),
  };

  const results = [];
  try {
    for (const file of files) {
      results.push(await client.upsertFile(file.path, file.content, file.message));
    }
  } catch (err) {
    console.error('[LeetGit] sync failed', err);
    // Keep the payload so the popup can retry once the problem (usually the token) is fixed.
    await appendHistory({ ...base, status: 'error', error: err.message, results, payload });
    flashBadge('!', '#b91c1c');
    return { ok: false, error: err.message, folder, results };
  }

  await markSynced(submissionId);
  await appendHistory({ ...base, status: 'ok', results });
  flashBadge('✓', '#15803d');
  return { ok: true, folder, url: base.url, results };
}

async function testConnection(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (!isConfigured(settings)) throw new Error('Token, repository and branch are required');
  const client = new GitHubClient(settings);
  const info = await client.checkAccess();
  return { ok: true, ...info };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message && message.type) {
    case 'SYNC_ACCEPTED':
    case 'RETRY_SYNC': {
      const job = queue.then(() => syncSubmission(message.payload));
      queue = job.catch(() => {});
      job.then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    case 'TEST_CONNECTION':
      testConnection(message.settings).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: err.message }),
      );
      return true;
    default:
      return false;
  }
});

/**
 * Content scripts declared in the manifest only run in pages loaded after the
 * extension (re)loads. Inject into LeetCode tabs that are already open so an
 * install, an update or a developer reload does not require refreshing them.
 */
async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://leetcode.com/*' });
  } catch (err) {
    console.warn('[LeetGit] cannot list LeetCode tabs', err);
    return;
  }
  for (const tab of tabs) {
    if (!tab.id || tab.discarded) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: ['src/injected.js'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content.js'],
      });
    } catch (err) {
      console.warn(`[LeetGit] could not inject into tab ${tab.id}`, err);
    }
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await injectIntoOpenTabs();
  if (details.reason !== 'install') return;
  const settings = await getSettings();
  if (!isConfigured(settings)) chrome.runtime.openOptionsPage();
});
