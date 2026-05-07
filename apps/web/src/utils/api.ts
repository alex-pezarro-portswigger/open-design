/**
 * Daemon-API client helpers.
 *
 * The daemon protects every /api/* route (other than a small bootstrap
 * allow-list) with a per-process session token. The frontend obtains the
 * token by hitting GET /api/daemon-token, which both returns it in the
 * response body and sets an `od_session` HttpOnly cookie on /api. With
 * the cookie in place the browser carries the token automatically on:
 *
 *   - fetch() / XHR
 *   - EventSource
 *   - iframe sub-asset fetches (relative URLs resolved against a base
 *     href, e.g. `<img src="foo.png">` inside an iframe loaded from
 *     /api/projects/:id/raw/index.html)
 *   - <img src>, <link href>, etc.
 *
 * `apiFetch` is a thin fetch() wrapper that
 *   1. lazily bootstraps the cookie/token before the first call,
 *   2. attaches the X-OD-Session-Token header as belt-and-suspenders
 *      (in case the cookie was rejected for some reason), and
 *   3. on a 401 response re-bootstraps and retries once — which is what
 *      lets a session survive a daemon restart without a page reload.
 *
 * Test mode: callers can pre-seed the bootstrap state via
 * __setDaemonAuthBootstrappedForTests__ so unit tests that stub global
 * fetch don't see a leading bootstrap call.
 */

let bootstrapPromise: Promise<string | null> | null = null;
let cachedToken: string | null = null;

const TOKEN_HEADER = 'X-OD-Session-Token';
const TOKEN_QUERY_PARAM = '_token';

function rawFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

async function bootstrapDaemonAuthOnce(): Promise<string | null> {
  try {
    const resp = await rawFetch('/api/daemon-token', {
      method: 'GET',
      // `same-origin` is the fetch default but we set it explicitly because
      // the daemon's cookie is only useful when it lands on the page origin.
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!resp.ok) return null;
    const data = (await resp.json().catch(() => null)) as { token?: unknown } | null;
    const token = data && typeof data.token === 'string' ? data.token : null;
    cachedToken = token;
    return token;
  } catch {
    return null;
  }
}

export function ensureDaemonAuth(): Promise<string | null> {
  if (cachedToken !== null) return Promise.resolve(cachedToken);
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapDaemonAuthOnce().finally(() => {
      // Clear the in-flight promise but keep the cached token so a transient
      // failure doesn't permanently wedge subsequent calls.
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

function attachTokenHeader(init: RequestInit | undefined, token: string | null): RequestInit {
  if (!token) return init ?? {};
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has(TOKEN_HEADER)) headers.set(TOKEN_HEADER, token);
  return { ...init, headers, credentials: init?.credentials ?? 'same-origin' };
}

/**
 * fetch() against the daemon API. Call this anywhere the previous code
 * called fetch('/api/...') directly — it preserves the same input/init
 * shape and just layers token attach + 401 retry on top.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let token = cachedToken;
  if (token === null) token = await ensureDaemonAuth();

  const first = await rawFetch(input, attachTokenHeader(init, token));
  if (first.status !== 401) return first;

  // Token rejected — most likely the daemon was restarted and minted a fresh
  // one. Force re-bootstrap and retry once. If the second attempt is still
  // 401, the caller's normal error handling kicks in.
  cachedToken = null;
  bootstrapPromise = null;
  // Drain the body so the connection can be reused / GC'd.
  try { await first.body?.cancel(); } catch { /* ignore */ }
  const refreshed = await ensureDaemonAuth();
  if (!refreshed) return first;
  return rawFetch(input, attachTokenHeader(init, refreshed));
}

/**
 * Append the session token as a `_token` query param to a same-origin URL.
 * Used for the rare cases where neither the cookie nor a header is going
 * to work (e.g. a third-party `<img src>` library that builds the URL out
 * of band). For app-controlled fetch sites prefer apiFetch instead.
 *
 * Synchronous — relies on a previous ensureDaemonAuth() having seeded the
 * cache. If the token isn't known yet, returns the path unchanged and
 * lets the caller decide how to handle a likely 401.
 */
export function apiUrl(path: string): string {
  if (!cachedToken) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${TOKEN_QUERY_PARAM}=${encodeURIComponent(cachedToken)}`;
}

/** Test-only seam: pre-populate the bootstrap cache so unit tests that
 *  stub fetch don't observe a leading /api/daemon-token call. */
export function __setDaemonAuthBootstrappedForTests__(token: string | null): void {
  cachedToken = token;
  bootstrapPromise = null;
}
