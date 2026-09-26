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
      const detail = json?.message || `HTTP ${res.status}`;
      throw new GitHubError(`GitHub ${method} ${path} failed: ${detail}`, res.status, json);
    }
    return json;
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

  /** Verifies the token can see the repo and the branch, and whether it can push. */
  async checkAccess() {
    const repo = await this.request('GET', this.repoPath);
    const branch = await this.request(
      'GET',
      `${this.repoPath}/branches/${encodeURIComponent(this.branch)}`,
    );
    return {
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      branch: branch.name,
      canPush: Boolean(repo.permissions?.push),
      isPrivate: Boolean(repo.private),
    };
  }
}
