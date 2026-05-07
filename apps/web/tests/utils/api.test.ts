import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __setDaemonAuthBootstrappedForTests__,
  apiFetch,
  apiUrl,
  ensureDaemonAuth,
} from '../../src/utils/api';

const TOKEN = 'bootstrap-token-1234';

beforeEach(() => {
  __setDaemonAuthBootstrappedForTests__(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setDaemonAuthBootstrappedForTests__(null);
});

describe('ensureDaemonAuth', () => {
  it('hits /api/daemon-token once and caches the result for subsequent callers', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/daemon-token') {
        return new Response(JSON.stringify({ token: TOKEN }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b, c] = await Promise.all([
      ensureDaemonAuth(),
      ensureDaemonAuth(),
      ensureDaemonAuth(),
    ]);

    expect(a).toBe(TOKEN);
    expect(b).toBe(TOKEN);
    expect(c).toBe(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves to null when the daemon is unreachable and lets a later attempt retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: TOKEN }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await ensureDaemonAuth()).toBeNull();
    expect(await ensureDaemonAuth()).toBe(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('apiFetch', () => {
  it('attaches the X-OD-Session-Token header to outgoing requests', async () => {
    __setDaemonAuthBootstrappedForTests__(TOKEN);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/agents');

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('x-od-session-token')).toBe(TOKEN);
    expect(init?.credentials).toBe('same-origin');
  });

  it('preserves caller-provided method, body, and headers', async () => {
    __setDaemonAuthBootstrappedForTests__(TOKEN);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ hello: 'world' }));
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-od-session-token')).toBe(TOKEN);
  });

  it('re-bootstraps and retries once on a 401 response', async () => {
    __setDaemonAuthBootstrappedForTests__('stale-token');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/daemon-token') {
        return new Response(JSON.stringify({ token: 'fresh-token' }), { status: 200 });
      }
      const sent = new Headers(init?.headers).get('x-od-session-token');
      if (sent === 'fresh-token') return new Response('{}', { status: 200 });
      return new Response('{"error":"invalid session token"}', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const resp = await apiFetch('/api/agents');

    expect(resp.status).toBe(200);
    // Three calls: stale-token /api/agents → 401, /api/daemon-token → fresh, /api/agents with fresh → 200.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/daemon-token');
  });
});

describe('apiUrl', () => {
  it('appends the cached token as a _token query param', () => {
    __setDaemonAuthBootstrappedForTests__(TOKEN);
    expect(apiUrl('/api/projects/abc/events')).toBe(
      `/api/projects/abc/events?_token=${encodeURIComponent(TOKEN)}`,
    );
  });

  it('preserves an existing query string', () => {
    __setDaemonAuthBootstrappedForTests__(TOKEN);
    expect(apiUrl('/api/runs?status=active')).toBe(
      `/api/runs?status=active&_token=${encodeURIComponent(TOKEN)}`,
    );
  });

  it('returns the path unchanged when the token has not bootstrapped yet', () => {
    expect(apiUrl('/api/projects/abc/events')).toBe('/api/projects/abc/events');
  });
});
