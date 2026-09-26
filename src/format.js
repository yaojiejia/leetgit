/**
 * Pure helpers that reproduce the LeetSync repository layout used in this repo:
 *
 *   {questionId}-{titleSlug}/
 *     README.md          <h2><a href="...">Title</a></h2> <img difficulty badge /><hr>{problem HTML}
 *     {titleSlug}.{ext}  the submitted code, verbatim
 *     Notes.md           <h2>{titleSlug} Notes</h2><hr>[ Time taken: 12 m 20 s ]   (optional)
 *
 * Commit messages:
 *   Added README.md file for {Title}
 *   Time: 95 ms (5.15%) | Memory: 29.3 MB (7.53%) - LeetSync
 *   Added Notes.md file for {Title}
 *
 * Nothing here touches the DOM or Chrome APIs, so it also runs under Node for tests.
 */

export const DEFAULT_SETTINGS = {
  token: '',
  owner: '',
  repo: '',
  branch: 'main',
  commitSuffix: 'LeetSync',
  folderIdMode: 'questionId', // 'questionId' (internal id, matches existing folders) | 'frontendId'
  notesEnabled: false,
  enabled: true,
};

// LeetCode language slug -> file extension.
export const LANG_EXTENSIONS = {
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  java: 'java',
  python: 'py',
  python3: 'py',
  pythondata: 'py',
  javascript: 'js',
  typescript: 'ts',
  php: 'php',
  swift: 'swift',
  kotlin: 'kt',
  dart: 'dart',
  golang: 'go',
  ruby: 'rb',
  scala: 'scala',
  rust: 'rs',
  racket: 'rkt',
  erlang: 'erl',
  elixir: 'ex',
  mysql: 'sql',
  mssql: 'sql',
  oraclesql: 'sql',
  postgresql: 'sql',
  bash: 'sh',
};

const DIFFICULTY_COLORS = {
  Easy: 'brightgreen',
  Medium: 'orange',
  Hard: 'red',
};

export function extensionFor(lang) {
  const key = String(lang || '').toLowerCase();
  return LANG_EXTENSIONS[key] || 'txt';
}

export function folderName(question, idMode = 'questionId') {
  const id = idMode === 'frontendId' ? question.questionFrontendId : question.questionId;
  return `${id}-${question.titleSlug}`;
}

export function readmeContent(question) {
  const difficulty = question.difficulty || 'Unknown';
  const color = DIFFICULTY_COLORS[difficulty] || 'blue';
  return (
    `<h2><a href="https://leetcode.com/problems/${question.titleSlug}">${question.title}</a></h2> ` +
    `<img src='https://img.shields.io/badge/Difficulty-${difficulty}-${color}' alt='Difficulty: ${difficulty}' /><hr>` +
    (question.content || '')
  );
}

export function formatPercentile(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const n = Number(value);
  return Number.isNaN(n) ? 'N/A' : `${n.toFixed(2)}%`;
}

export function solutionCommitMessage(stats, suffix) {
  const base =
    `Time: ${stats.runtime ?? 'N/A'} (${formatPercentile(stats.runtimePercentile)}) | ` +
    `Memory: ${stats.memory ?? 'N/A'} (${formatPercentile(stats.memoryPercentile)})`;
  const trimmed = String(suffix ?? '').trim();
  return trimmed ? `${base} - ${trimmed}` : base;
}

export function readmeCommitMessage(title) {
  return `Added README.md file for ${title}`;
}

export function notesCommitMessage(title) {
  return `Added Notes.md file for ${title}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} h`);
  parts.push(`${m} m`, `${s} s`);
  return parts.join(' ');
}

export function notesContent(titleSlug, timeTakenMs) {
  return `<h2>${titleSlug} Notes</h2><hr>[ Time taken: ${formatDuration(timeTakenMs)} ]`;
}

/**
 * Accepts "owner/repo", "https://github.com/owner/repo", "github.com/owner/repo.git", ...
 * Returns { owner, repo } or null.
 */
export function parseRepo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  if (url) return { owner: url[1], repo: url[2] };
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short) return { owner: short[1], repo: short[2] };
  return null;
}

/**
 * Turns an accepted submission into the ordered list of files to commit.
 * Order matches the existing history: README first, then the solution, then Notes.
 *
 * submission = {
 *   question: { questionId, questionFrontendId, title, titleSlug, difficulty, content },
 *   lang, code, runtime, memory, runtimePercentile, memoryPercentile, timeTakenMs
 * }
 */
export function buildSyncPlan(submission, settings) {
  const q = submission.question;
  const folder = folderName(q, settings.folderIdMode);
  const files = [
    {
      path: `${folder}/README.md`,
      content: readmeContent(q),
      message: readmeCommitMessage(q.title),
    },
    {
      path: `${folder}/${q.titleSlug}.${extensionFor(submission.lang)}`,
      content: submission.code,
      message: solutionCommitMessage(submission, settings.commitSuffix),
    },
  ];
  if (settings.notesEnabled && submission.timeTakenMs != null) {
    files.push({
      path: `${folder}/Notes.md`,
      content: notesContent(q.titleSlug, submission.timeTakenMs),
      message: notesCommitMessage(q.title),
    });
  }
  return { folder, files };
}
