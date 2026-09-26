# LeetGit Privacy Policy

_Last updated: 2026-09-26_

LeetGit is a browser extension that commits your accepted LeetCode submissions to a GitHub repository you choose. It is built for a single purpose and collects nothing beyond what that purpose needs.

## What the extension handles

- **GitHub personal access token.** You enter it on the settings page. It is stored in the extension's local storage in your browser profile and is sent only to `api.github.com`, in the `Authorization` header of requests that create or update files in your repository.
- **Repository name and branch.** Stored locally so the extension knows where to commit.
- **Submission data.** When LeetCode reports a submission as Accepted, the extension reads the submitted code, the problem's title, difficulty, description and id, and the runtime and memory figures. This data is read from the LeetCode page you are on and from LeetCode's own API using your existing LeetCode login. It is sent only to `api.github.com` as the content of the commit.
- **Sync history.** The last 50 sync results (problem name, folder, timestamp, and any error message) are kept in local storage so the popup can show them. You can clear this list from the popup.

## What the extension does not do

- It does not send any data to the extension's author or to any third party other than GitHub and LeetCode.
- It does not use analytics, tracking, advertising, or remote code.
- It does not read LeetCode pages other than to detect accepted submissions, and it does not access any website other than `leetcode.com` and `api.github.com`.
- It does not sync your token or settings between devices.

## Data retention and removal

Everything the extension stores lives in your browser profile. Removing the extension deletes it. You can also revoke the GitHub token at any time from GitHub's settings, which immediately stops the extension from being able to commit.

## Source code

The extension is open source: https://github.com/yaojiejia/leetgit

## Contact

Open an issue on the repository above.
