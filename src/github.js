/**
 * Minimal GitHub REST client for the Contents API.
 * Runs in the extension service worker (and under Node for tests).
 */

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToUtf8(b64) {
  const binary = atob(String(b64 ?? '').replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export class GitHubClient {
  constructor({ token, owner, repo, branch }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || 'main';
  }

  get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async request(method, path, body) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty or non-JSON body */
    }

    if (!res.ok) {
      const detail = this.explain(res.status, json?.message || `HTTP ${res.status}`, method);
      throw new GitHubError(`GitHub ${method} ${path} failed: ${detail}`, res.status, json);
    }
    return json;
  }

  /** Adds the fix to GitHub's terse error messages. */
  explain(status, message, method) {
    const target = `${this.owner}/${this.repo}`;
    if (status === 401) {
      return `${message}. The token is invalid or has expired; create a new one in the settings.`;
    }
    if (status === 403 && /not accessible by (personal access token|integration)/i.test(message)) {
      return (
        `${message}. The token cannot write to ${target}. For a fine-grained token, add this repository ` +
        'under "Repository access" and set "Contents" to "Read and write". A classic token needs the "repo" scope.'
      );
    }
    if (status === 404 && method !== 'GET') {
      return `${message}. ${target} does not exist, or the token cannot see it.`;
    }
    return message;
  }

  static encodePath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  /** Returns the Contents API record for a file, or null if it does not exist. */
  async getFile(path) {
    const url =
      `${this.repoPath}/contents/${GitHubClient.encodePath(path)}` +
      `?ref=${encodeURIComponent(this.branch)}`;
    try {
      return await this.request('GET', url);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async putFile(path, content, message, sha) {
    const body = { message, content: utf8ToBase64(content), branch: this.branch };
    if (sha) body.sha = sha;
    return this.request('PUT', `${this.repoPath}/contents/${GitHubClient.encodePath(path)}`, body);
  }

  /**
   * Creates or updates a file with one commit. Skips the commit entirely when
   * the file already holds exactly this content, so re-submitting an identical
   * solution does not add empty commits.
   */
  async upsertFile(path, content, message) {
    const existing = await this.getFile(path);
    if (existing && existing.type === 'file' && typeof existing.content === 'string') {
      if (base64ToUtf8(existing.content) === content) {
        return { path, action: 'unchanged', sha: existing.sha };
      }
    }
    const result = await this.putFile(path, content, message, existing?.sha);
    return {
      path,
      action: existing ? 'updated' : 'created',
      sha: result?.content?.sha,
      commitUrl: result?.commit?.html_url,
    };
  }

  /**
   * Verifies the token can see the repo and the branch, and that it can write.
   * The repo's `permissions` field describes the user's rights, not the token's,
   * so write access is probed by creating a dangling git blob: no commit, no
   * visible change, and GitHub garbage-collects it.
   */
  async checkAccess() {
    const repo = await this.request('GET', this.repoPath);
    const branch = await this.request(
      'GET',
      `${this.repoPath}/branches/${encodeURIComponent(this.branch)}`,
    );
    let canPush = false;
    let pushError = null;
    try {
      await this.request('POST', `${this.repoPath}/git/blobs`, {
        content: 'LeetGit connection test',
        encoding: 'utf-8',
      });
      canPush = true;
    } catch (err) {
      if (!(err instanceof GitHubError) || (err.status !== 403 && err.status !== 404)) throw err;
      pushError = err.message;
    }
    return {
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      branch: branch.name,
      canPush,
      pushError,
      isPrivate: Boolean(repo.private),
    };
  }
}
