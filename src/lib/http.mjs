import fs from 'node:fs/promises';
import path from 'node:path';
import { API_INTERVAL_MS, CACHE_DIR } from '../config.mjs';
import { ensureDir, pathExists, readJson, sha256, writeJson } from './fs.mjs';

let lastApiRequest = 0;
let apiGate = Promise.resolve();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function headerObject(headers) {
  return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
}

async function throttle(url) {
  if (!new URL(url).pathname.startsWith('/api/v0/')) return;
  const turn = apiGate.then(async () => {
    const wait = Math.max(0, API_INTERVAL_MS - (Date.now() - lastApiRequest));
    if (wait) await sleep(wait);
    lastApiRequest = Date.now();
  });
  apiGate = turn.catch(() => {});
  await turn;
}

function cachePaths(url, kind) {
  const key = sha256(`${kind}:${url}`);
  return {
    body: path.join(CACHE_DIR, 'responses', `${key}.body`),
    meta: path.join(CACHE_DIR, 'responses', `${key}.json`),
  };
}

export async function cachedRequest(url, options = {}) {
  const {
    accept = '*/*', kind = 'text', refresh = false, method = 'GET',
    retries = 6, redirect = 'follow', cache = method === 'GET', headers = {},
  } = options;
  const targets = cachePaths(url, `${method}:${kind}`);
  if (cache && !refresh && await pathExists(targets.meta) && await pathExists(targets.body)) {
    const meta = await readJson(targets.meta);
    const body = await fs.readFile(targets.body);
    return { ...meta, body, fromCache: true };
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await throttle(url);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const response = await fetch(url, {
        method, redirect, signal: controller.signal,
        headers: { 'accept': accept, 'user-agent': 'JVsup-Forge-Static-Archive/1.0', ...headers },
      }).finally(() => clearTimeout(timer));
      const responseHeaders = headerObject(response.headers);
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 750 * (2 ** attempt));
        await response.arrayBuffer().catch(() => null);
        if (attempt < retries) {
          await sleep(delay);
          continue;
        }
      }
      const manualRedirect = redirect === 'manual' && [301, 302, 303, 307, 308].includes(response.status);
      if (!response.ok && !manualRedirect) {
        const error = new Error(`HTTP ${response.status} for ${url}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      const body = Buffer.from(await response.arrayBuffer());
      const meta = {
        requestUrl: url, finalUrl: response.url || url, status: response.status,
        headers: responseHeaders, capturedAt: new Date().toISOString(),
      };
      if (cache) {
        await ensureDir(path.dirname(targets.body));
        await fs.writeFile(targets.body, body);
        await writeJson(targets.meta, meta);
      }
      return { ...meta, body, fromCache: false };
    } catch (error) {
      lastError = error;
      if (error.retryable === false) break;
      if (attempt < retries) await sleep(Math.min(30_000, 750 * (2 ** attempt)));
    }
  }
  throw lastError;
}

export async function fetchJson(url, options = {}) {
  const result = await cachedRequest(url, { ...options, accept: 'application/json', kind: 'json' });
  let parsed;
  try {
    parsed = JSON.parse(result.body.toString('utf8'));
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
  if (parsed?.success === false) throw new Error(parsed.message || `API failure for ${url}`);
  return { ...result, json: parsed };
}

export async function fetchText(url, options = {}) {
  const result = await cachedRequest(url, { ...options, accept: 'text/html,application/xhtml+xml', kind: 'html' });
  return { ...result, text: result.body.toString('utf8') };
}

export async function fetchPaginated(baseUrl, params = {}) {
  const collected = [];
  let page = 1;
  let pages = 1;
  do {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries({ ...params, page, per_page: 50 })) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const { json } = await fetchJson(url.href);
    if (!Array.isArray(json.data)) throw new Error(`Expected paginated data from ${url.href}`);
    collected.push(...json.data);
    pages = Number(json.meta?.last_page || 1);
    page += 1;
  } while (page <= pages);
  return collected;
}

export async function resolveExternalRedirect(startUrl) {
  if (!startUrl) return { status: 'missing', url: null };
  let current = startUrl;
  try {
    for (let hop = 0; hop < 10; hop += 1) {
      const result = await cachedRequest(current, {
        method: 'HEAD', redirect: 'manual', cache: true, kind: 'redirect', retries: 3,
      });
      const location = result.headers.location;
      if (![301, 302, 303, 307, 308].includes(result.status) || !location) {
        return { status: 'resolved', url: current, hops: hop };
      }
      current = new URL(location, current).href;
    }
    return { status: 'failed', url: null, reason: 'too_many_redirects' };
  } catch (headError) {
    try {
      const result = await cachedRequest(startUrl, {
        method: 'GET', redirect: 'manual', cache: false, kind: 'redirect-get', retries: 2,
        headers: { range: 'bytes=0-0' },
      });
      const location = result.headers.location;
      return location
        ? resolveExternalRedirect(new URL(location, startUrl).href)
        : { status: 'resolved', url: result.finalUrl || startUrl, hops: 0 };
    } catch (getError) {
      return { status: 'failed', url: null, reason: getError.message || headError.message };
    }
  }
}
