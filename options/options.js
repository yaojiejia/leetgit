import { DEFAULT_SETTINGS, parseRepo } from '../src/format.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const status = $('status');

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

function readForm() {
  const repoInput = $('repo').value;
  const parsed = parseRepo(repoInput);
  return {
    token: $('token').value.trim(),
    owner: parsed ? parsed.owner : '',
    repo: parsed ? parsed.repo : '',
    branch: $('branch').value.trim() || 'main',
    commitSuffix: $('commitSuffix').value,
    folderIdMode: form.querySelector('input[name="folderIdMode"]:checked').value,
    notesEnabled: $('notesEnabled').checked,
    enabled: $('enabled').checked,
    repoInputValid: Boolean(parsed) || !repoInput.trim(),
  };
}

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  $('token').value = s.token;
  $('repo').value = s.owner && s.repo ? `${s.owner}/${s.repo}` : '';
  $('branch').value = s.branch;
  $('commitSuffix').value = s.commitSuffix;
  form.querySelector(`input[name="folderIdMode"][value="${s.folderIdMode}"]`).checked = true;
  $('notesEnabled').checked = s.notesEnabled;
  $('enabled').checked = s.enabled;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readForm();
  if (!values.repoInputValid) {
    setStatus('Repository must look like owner/repo or a github.com URL.', 'error');
    $('repo').focus();
    return;
  }
  const { repoInputValid, ...settings } = values;
  await chrome.storage.local.set({ settings });
  setStatus('Saved.', 'ok');
});

$('test').addEventListener('click', async () => {
  const values = readForm();
  if (!values.repoInputValid || !values.owner) {
    setStatus('Enter a repository first.', 'error');
    return;
  }
  $('test').disabled = true;
  setStatus('Checking…');
  try {
    const { repoInputValid, ...settings } = values;
    const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', settings });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Unknown error');
    if (!res.canPush) {
      setStatus(`Connected to ${res.fullName}, but this token cannot push. Give it Contents: Read and write.`, 'error');
    } else {
      setStatus(`Connected to ${res.fullName} (branch ${res.branch}). Push access OK.`, 'ok');
    }
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    $('test').disabled = false;
  }
});

$('toggleToken').addEventListener('click', () => {
  const input = $('token');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('toggleToken').textContent = show ? 'Hide' : 'Show';
});

load();
