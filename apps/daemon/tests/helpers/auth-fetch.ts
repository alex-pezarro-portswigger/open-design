// Test helper: thread the daemon's per-process session token into requests
// fired against an in-process server started via `startServer`.
//
// The daemon-side `requireSessionToken` middleware (apps/daemon/src/server.ts)
// rejects /api/* requests that don't supply the token via header, query
// param, or cookie. Real-browser callers handle this through the web
// frontend's apiFetch wrapper; tests have to do it themselves.
//
// Use either `withDaemonAuth(init)` to mutate an init object, or
// `daemonFetch(url, init)` as a drop-in replacement for fetch.

// @ts-nocheck
import { DAEMON_SESSION_TOKEN } from '../../src/server.js';

export const SESSION_TOKEN_HEADER = 'X-OD-Session-Token';

export function withDaemonAuth(init) {
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has(SESSION_TOKEN_HEADER)) {
    headers.set(SESSION_TOKEN_HEADER, DAEMON_SESSION_TOKEN);
  }
  return { ...(init ?? {}), headers };
}

export function daemonFetch(url, init) {
  return fetch(url, withDaemonAuth(init));
}

// Add the same token to a `node:http` request's headers map. Used by the
// raw httpRequest helpers in tests that exercise non-loopback Host headers.
export function withDaemonAuthHeaders(headers) {
  return { ...(headers ?? {}), [SESSION_TOKEN_HEADER]: DAEMON_SESSION_TOKEN };
}
