import { DEFAULT_SETTINGS } from '../src/format.js';

const $ = (id) => document.getElementById(id);

function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

function describeResults(results) {
  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const r of results || []) counts[r.action] = (counts[r.action] || 0) + 1;
  const parts = [];
  if (counts.created) parts.push(`${counts.created} added`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts.unchanged && !counts.created && !counts.updated) parts.push('already up to date');
  return parts.join(', ');
}

function renderTarget(settings) {
  const el = $('target');
  el.textContent = '';
  if (!settings.token || !settings.owner || !settings.repo) {
    const p = document.createElement('p');
    p.className = 'muted warn';
    p.textContent = 'Not configured yet. Open Settings to add your GitHub token and repository.';
    el.appendChild(p);
    return;
  }
  const p = document.createElement('p');
  p.className = 'muted';
  p.append(settings.enabled ? 'Syncing to ' : 'Paused. Target: ');
  const a = document.createElement('a');
  a.href = `https://github.com/${settings.owner}/${settings.repo}/tree/${settings.branch}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = `${settings.owner}/${settings.repo}`;
  p.appendChild(a);
  p.append(` (${settings.branch})`);
  el.appendChild(p);
}

function renderHistory(history) {
  const list = $('history');
  list.textContent = '';
  $('empty').hidden = history.length > 0;
  for (const entry of history) {
    const li = document.createElement('li');

    const title = document.createElement('div');
    title.className = 'title';
    const dot = document.createElement('span');
    dot.className = `dot${entry.status === 'error' ? ' error' : ''}`;
    const a = document.createElement('a');
    a.href = entry.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = entry.title || entry.folder;
    a.title = entry.folder;
    title.append(dot, a);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [entry.lang, entry.runtime, entry.memory, timeAgo(entry.time), describeResults(entry.results)]
      .filter(Boolean)
      .join(' · ');

    li.append(title, meta);
    if (entry.status === 'error') {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = entry.error;
      li.appendChild(err);
      if (entry.payload) {
        const retry = document.createElement('button');
        retry.className = 'retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          retry.textContent = 'Retrying…';
          try {
            await chrome.runtime.sendMessage({ type: 'RETRY_SYNC', payload: entry.payload });
          } finally {
            load();
          }
        });
        li.appendChild(retry);
      }
    }
    list.appendChild(li);
  }
}

async function load() {
  const { settings, history = [] } = await chrome.storage.local.get(['settings', 'history']);
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  $('enabled').checked = s.enabled;
  renderTarget(s);
  renderHistory(history);
}

$('enabled').addEventListener('change', async (event) => {
  const { settings } = await chrome.storage.local.get('settings');
  const next = { ...DEFAULT_SETTINGS, ...(settings || {}), enabled: event.target.checked };
  await chrome.storage.local.set({ settings: next });
  renderTarget(next);
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('clearHistory').addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [], diagnostics: [] });
  renderHistory([]);
});

$('copyDiag').addEventListener('click', async () => {
  const button = $('copyDiag');
  const { settings, history = [], diagnostics = [] } = await chrome.storage.local.get([
    'settings',
    'history',
    'diagnostics',
  ]);
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const report = {
    version: chrome.runtime.getManifest().version,
    settings: { ...s, token: s.token ? `set (${s.token.length} chars)` : 'missing' },
    history: history.map(({ payload, ...rest }) => rest),
    log: diagnostics.map((d) => `${new Date(d.t).toISOString()} [${d.src}] ${d.line}`),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = 'Copy diagnostics';
  }, 2000);
});

load();
