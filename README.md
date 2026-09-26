# LeetGit

A Chrome extension that watches leetcode.com and, every time a submission is **Accepted**, commits it to a GitHub repository. It writes the same layout the LeetSync extension produced, so it can keep adding to an existing solutions repo such as [yaojiejia/myLeet](https://github.com/yaojiejia/myLeet) without changing its structure:

```
121-best-time-to-buy-and-sell-stock/
├── README.md                          # <h2><a href=…>Title</a></h2> <img difficulty badge /><hr>{problem HTML}
├── best-time-to-buy-and-sell-stock.py # the code exactly as submitted
└── Notes.md                           # optional: <h2>{slug} Notes</h2><hr>[ Time taken: 12 m 20 s ]
```

Commits, in order, per accepted submission:

1. `Added README.md file for Best Time to Buy and Sell Stock`
2. `Time: 95 ms (5.15%) | Memory: 29.3 MB (7.53%) - LeetSync`
3. `Added Notes.md file for Best Time to Buy and Sell Stock` (only when Notes are enabled)

Files whose content has not changed are skipped, so re-submitting the same code produces no empty commits.

## Install

1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. Clone this repository, click **Load unpacked**, and pick the cloned folder (the one containing `manifest.json`).
3. The settings page opens automatically on first install (or click the extension icon → **Settings**).

## Configure

1. Create a GitHub token at <https://github.com/settings/personal-access-tokens/new>:
   - **Repository access:** Only select repositories → your solutions repo.
   - **Permissions → Contents:** Read and write.
   - (A classic token with the `repo` scope also works.)
2. Paste the token, enter the repository as `owner/repo` (or its URL) and the branch.
3. Click **Test connection**. It confirms the repo, the branch, and that the token can push.
4. **Save**.

The token is stored in the extension's local storage for this browser profile only and is sent exclusively to `api.github.com`.

### Options

| Setting | Default | Notes |
| --- | --- | --- |
| Commit message suffix | `LeetSync` | Keeps history uniform with the existing commits. Clear it to drop the ` - LeetSync` tail. |
| Folder number | Internal question id | LeetSync used LeetCode's internal id, which is why Fibonacci Number (#509 on the site) lives in `1013-fibonacci-number`. Switch to the displayed number if you prefer `509-…`. |
| Notes.md | off | Records time from opening the problem in a tab until acceptance. |
| Sync enabled | on | Also toggleable from the popup. |

## How it works

- `src/injected.js` runs in the page's main world and wraps `fetch`/`XMLHttpRequest`. It sees the `POST /problems/{slug}/submit/` request (remembering the submitted code) and the `GET /submissions/detail/{id}/check/` polling response. When that response says `Accepted`, it posts an event to the content script.
- `src/content.js` (isolated world) fills in anything missing through LeetCode's GraphQL API using your existing login session: problem title, difficulty, description, internal id, and, if needed, the code and percentiles for the submission. It then messages the service worker and shows a toast on the page with the result.
- `src/background.js` (service worker) builds the file list with `src/format.js`, then uses the GitHub Contents API (`src/github.js`) to create or update each file with its own commit. Submissions are processed one at a time and each submission id is synced once.
- The popup lists recent syncs with links to the folder on GitHub; failures show the error there and on the toolbar badge.

Permissions: `storage`, `scripting`, and host access to `api.github.com` and `leetcode.com`. The LeetCode host permission is used only to inject the scripts into LeetCode tabs that are already open when the extension is installed, updated or reloaded. Calls to LeetCode's API are made from the page itself with your existing login.

## Development

```bash
npm test        # unit tests (node --test); compares output against fixtures copied from a real LeetSync repo
npm run check   # syntax-check every script
```

No build step. Edit the files and click the reload icon on `chrome://extensions`.

## Troubleshooting

- **"LeetGit was reloaded or updated. Refresh this tab to resume syncing."** or an error mentioning `sendMessage` / `Extension context invalidated`: the extension was reloaded (for example after editing it, or after loading it again from a new folder) while this LeetCode tab was open, which cuts the tab's old script off from the extension. Since 1.0.1 the extension re-injects itself into open tabs automatically. If you still see it, refresh the tab and submit again.
- **Nothing happens on Accepted:** check the popup for an error entry, and make sure the tab was opened (or refreshed) after the extension was installed.
- A submission that failed to sync is not retried. Submit the problem again once the issue is fixed.

## Limitations

- Only leetcode.com (not leetcode.cn) and only the regular problem pages. Contest submissions go through a different endpoint and are not captured.
- If LeetCode changes its submission endpoints, the regular expressions at the top of `src/injected.js` are the place to update.
- Files larger than 1 MB cannot be compared through the Contents API and would be rewritten every time. LeetCode solutions are far below that.
