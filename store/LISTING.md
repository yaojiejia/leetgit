# Chrome Web Store listing

Everything below is ready to paste into the developer dashboard at
https://chrome.google.com/webstore/devconsole.

## Build the upload

```bash
npm run package        # -> dist/leetgit-<version>.zip
```

Upload that zip on the **Package** tab. Bump `version` in `manifest.json` before every new upload; the store rejects a version it has already seen.

## Store listing tab

**Name:** LeetGit

**Summary (132 chars max):**
Commits every accepted LeetCode submission to your GitHub repo, one folder per problem, in the LeetSync layout.

**Category:** Developer Tools

**Language:** English

**Detailed description:**

LeetGit watches leetcode.com and, every time one of your submissions is Accepted, commits it to a GitHub repository you choose.

Each problem gets its own folder containing the problem statement (README.md with a difficulty badge) and your solution file, named after the problem. Commit messages record the runtime and memory result of the submission. The layout is identical to the one produced by the LeetSync extension, so LeetGit can keep adding to a repository that LeetSync started.

How it works
• Enter a GitHub personal access token that can write to one repository, plus the repository name and branch.
• Solve problems on leetcode.com as usual. When a submission is Accepted, LeetGit commits it and shows a small confirmation with a link to the folder on GitHub.
• Resubmitting identical code creates no empty commits. A changed solution updates the file in place.
• The popup lists recent syncs and lets you pause syncing.

Options
• Choose whether folders use LeetCode's internal question id (LeetSync-compatible) or the problem number shown on the site.
• Customize or remove the commit message suffix.
• Optionally record how long each problem took in a Notes.md file.

Privacy
Your token and settings stay in your browser. The extension talks only to leetcode.com (using your existing login) and api.github.com. No analytics, no third parties, no remote code. Source code: https://github.com/yaojiejia/leetgit

**Graphics:**
- Store icon 128×128: `icons/icon128.png`
- Screenshots (1280×800 or 640×400, at least one; take them in Chrome):
  1. A LeetCode problem page right after an Accepted submission, showing the green "Pushed … to GitHub" toast.
  2. The popup with a few entries in Recent syncs.
  3. The settings page after a successful Test connection.
  4. The resulting folder on GitHub.
- Small promo tile 440×280 (optional): `store/promo-440x280.png`

## Privacy practices tab

**Single purpose description:**
Commit the user's accepted LeetCode submissions to a GitHub repository the user chooses.

**Permission justifications:**

- `storage` — Stores the user's GitHub token, repository settings and a short local history of sync results.
- `scripting` — Re-injects the extension's content scripts into leetcode.com tabs that are already open when the extension is installed or updated, so the user does not have to refresh them.
- Host permission `https://leetcode.com/*` — Runs the content script that detects accepted submissions on LeetCode problem pages, and allows the re-injection described above.
- Host permission `https://api.github.com/*` — Creates and updates files in the user's repository through the GitHub REST API.

**Remote code:** No, I am not using remote code.

**Data usage:** Check **Authentication information** (the GitHub token) and **User activity** is *not* collected; **Website content** (the submitted code and problem text) is sent to GitHub at the user's request. Certify all three disclosures (not sold, only used for the single purpose, not used for creditworthiness).

**Privacy policy URL:**
https://github.com/yaojiejia/leetgit/blob/main/PRIVACY.md
(The repository must be public for this link to open. Run `gh repo edit yaojiejia/leetgit --visibility public`.)

## Distribution tab

**Visibility:** Unlisted — installable by anyone with the link, not shown in search. Switch to Public later if you want.

**Regions:** All regions.

## After approval

The store assigns a new extension id, different from the unpacked copy. Settings are stored per extension id, so after installing the store version:

1. Open its settings page and enter the token, repository and branch again.
2. Remove the unpacked copy from `chrome://extensions` so the two do not both commit.
