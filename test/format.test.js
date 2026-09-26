import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSyncPlan,
  extensionFor,
  folderName,
  formatDuration,
  notesContent,
  parseRepo,
  readmeContent,
  solutionCommitMessage,
  DEFAULT_SETTINGS,
} from '../src/format.js';
import { base64ToUtf8, utf8ToBase64 } from '../src/github.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Fixtures are copied verbatim from a LeetSync-generated solutions repo.
const fixtures = path.join(here, 'fixtures');
const sampleReadme = path.join(fixtures, 'best-time-to-buy-and-sell-stock.README.md');
const sampleNotes = path.join(fixtures, 'two-sum.Notes.md');

test('README reproduces an existing LeetSync README byte for byte', () => {
  const existing = readFileSync(sampleReadme, 'utf8');
  const hr = existing.indexOf('<hr>');
  const content = existing.slice(hr + '<hr>'.length);
  const generated = readmeContent({
    titleSlug: 'best-time-to-buy-and-sell-stock',
    title: 'Best Time to Buy and Sell Stock',
    difficulty: 'Easy',
    content,
  });
  assert.equal(generated, existing);
});

test('README badges use the same colours as the existing repo', () => {
  const q = { titleSlug: 'x', title: 'X', content: '' };
  assert.match(readmeContent({ ...q, difficulty: 'Easy' }), /Difficulty-Easy-brightgreen/);
  assert.match(readmeContent({ ...q, difficulty: 'Medium' }), /Difficulty-Medium-orange/);
  assert.match(readmeContent({ ...q, difficulty: 'Hard' }), /Difficulty-Hard-red/);
});

test('folder uses the internal question id by default, frontend id on request', () => {
  const q = { questionId: '1013', questionFrontendId: '509', titleSlug: 'fibonacci-number' };
  assert.equal(folderName(q), '1013-fibonacci-number');
  assert.equal(folderName(q, 'questionId'), '1013-fibonacci-number');
  assert.equal(folderName(q, 'frontendId'), '509-fibonacci-number');
});

test('solution commit message matches the existing history', () => {
  const stats = { runtime: '95 ms', runtimePercentile: 5.15, memory: '29.3 MB', memoryPercentile: 7.53 };
  assert.equal(
    solutionCommitMessage(stats, 'LeetSync'),
    'Time: 95 ms (5.15%) | Memory: 29.3 MB (7.53%) - LeetSync',
  );
  assert.equal(
    solutionCommitMessage({ runtime: '0 ms', runtimePercentile: 100, memory: '19.4 MB', memoryPercentile: 31.65 }, 'LeetSync'),
    'Time: 0 ms (100.00%) | Memory: 19.4 MB (31.65%) - LeetSync',
  );
  // SQL problems report "0B" memory on LeetCode; we pass it through untouched.
  assert.equal(
    solutionCommitMessage({ runtime: '484 ms', runtimePercentile: 81.16, memory: '0B', memoryPercentile: 100 }, 'LeetSync'),
    'Time: 484 ms (81.16%) | Memory: 0B (100.00%) - LeetSync',
  );
  assert.equal(solutionCommitMessage(stats, ''), 'Time: 95 ms (5.15%) | Memory: 29.3 MB (7.53%)');
  assert.equal(
    solutionCommitMessage({ runtime: '95 ms', runtimePercentile: null, memory: '29.3 MB' }, 'LeetSync'),
    'Time: 95 ms (N/A) | Memory: 29.3 MB (N/A) - LeetSync',
  );
});

test('Notes.md matches the existing format', () => {
  const existing = readFileSync(sampleNotes, 'utf8');
  assert.equal(notesContent('two-sum', (12 * 60 + 20) * 1000), existing);
});

test('duration formatting', () => {
  assert.equal(formatDuration(0), '0 m 0 s');
  assert.equal(formatDuration(4 * 60 * 1000 + 33 * 1000), '4 m 33 s');
  assert.equal(formatDuration(3600 * 1000 + 2 * 60 * 1000 + 3 * 1000), '1 h 2 m 3 s');
});

test('language extensions', () => {
  assert.equal(extensionFor('python3'), 'py');
  assert.equal(extensionFor('java'), 'java');
  assert.equal(extensionFor('postgresql'), 'sql');
  assert.equal(extensionFor('mysql'), 'sql');
  assert.equal(extensionFor('cpp'), 'cpp');
  assert.equal(extensionFor('golang'), 'go');
  assert.equal(extensionFor('somethingnew'), 'txt');
});

test('parseRepo accepts the common spellings', () => {
  assert.deepEqual(parseRepo('yaojiejia/myLeet'), { owner: 'yaojiejia', repo: 'myLeet' });
  assert.deepEqual(parseRepo('https://github.com/yaojiejia/myLeet'), { owner: 'yaojiejia', repo: 'myLeet' });
  assert.deepEqual(parseRepo('https://github.com/yaojiejia/myLeet.git'), { owner: 'yaojiejia', repo: 'myLeet' });
  assert.deepEqual(parseRepo('github.com/yaojiejia/myLeet/'), { owner: 'yaojiejia', repo: 'myLeet' });
  assert.equal(parseRepo('not a repo'), null);
  assert.equal(parseRepo(''), null);
});

test('sync plan produces README then solution, then optional Notes, in the right folder', () => {
  const submission = {
    submissionId: '1',
    question: {
      questionId: '121',
      questionFrontendId: '121',
      title: 'Best Time to Buy and Sell Stock',
      titleSlug: 'best-time-to-buy-and-sell-stock',
      difficulty: 'Easy',
      content: '<p>x</p>\n',
    },
    lang: 'python3',
    code: 'class Solution:\n    pass\n',
    runtime: '95 ms',
    runtimePercentile: 5.15,
    memory: '29.3 MB',
    memoryPercentile: 7.53,
    timeTakenMs: 740000,
  };

  const plan = buildSyncPlan(submission, DEFAULT_SETTINGS);
  assert.equal(plan.folder, '121-best-time-to-buy-and-sell-stock');
  assert.deepEqual(
    plan.files.map((f) => [f.path, f.message]),
    [
      ['121-best-time-to-buy-and-sell-stock/README.md', 'Added README.md file for Best Time to Buy and Sell Stock'],
      ['121-best-time-to-buy-and-sell-stock/best-time-to-buy-and-sell-stock.py', 'Time: 95 ms (5.15%) | Memory: 29.3 MB (7.53%) - LeetSync'],
    ],
  );
  assert.equal(plan.files[1].content, submission.code);

  const withNotes = buildSyncPlan(submission, { ...DEFAULT_SETTINGS, notesEnabled: true });
  assert.equal(withNotes.files.length, 3);
  assert.equal(withNotes.files[2].path, '121-best-time-to-buy-and-sell-stock/Notes.md');
  assert.equal(withNotes.files[2].message, 'Added Notes.md file for Best Time to Buy and Sell Stock');
  assert.equal(withNotes.files[2].content, '<h2>best-time-to-buy-and-sell-stock Notes</h2><hr>[ Time taken: 12 m 20 s ]');
});

test('base64 helpers round-trip UTF-8 and match GitHub encoding', () => {
  assert.equal(utf8ToBase64('hello'), 'aGVsbG8=');
  const text = 'def f():\n    return "héllo 🌍 中文"\n';
  assert.equal(base64ToUtf8(utf8ToBase64(text)), text);
  // GitHub wraps content with newlines every 60 chars; decoding must tolerate that.
  const wrapped = utf8ToBase64(text).replace(/(.{10})/g, '$1\n');
  assert.equal(base64ToUtf8(wrapped), text);
});
