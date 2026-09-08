import { lookup as dnsLookup } from 'node:dns/promises';
import type { AssistantToolEnv, ToolResult } from './types.js';

const MAX_WEB_BYTES = 256 * 1024;
const MAX_WEB_REDIRECTS = 3;
const WEB_TIMEOUT_MS = 10_000;

export async function webFetch(env: AssistantToolEnv, rawUrl: string): Promise<ToolResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid url' };
  }
  if (url.protocol !== 'https:' || url.hostname === '') return { ok: false, error: 'only https urls are fetched' };

  const resolveHost = env.resolveHost ?? defaultResolveHost;
  const fetchPage = env.fetchPage ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_WEB_REDIRECTS; hop++) {
    const addresses = await resolveHost(current.hostname).catch(() => []);
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      return { ok: false, error: `host ${current.hostname} is not reachable (private or unknown)` };
    }
    let response: Response;
    try {
      response = await fetchPage(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
        headers: { accept: 'text/*, application/json' },
      });
    } catch (error) {
      return { ok: false, error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) return { ok: false, error: `redirect without a location (${response.status})` };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, error: 'redirect location is not a valid url' };
      }
      if (current.protocol !== 'https:') return { ok: false, error: 'redirect left https' };
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^(text\/|application\/(json|xml))/.test(contentType)) {
      return { ok: false, error: `unsupported content-type: ${contentType || 'none'}` };
    }
    const body = await readCapped(response, MAX_WEB_BYTES);
    return {
      ok: true,
      content: JSON.stringify(
        {
          url: current.toString(),
          status: response.status,
          contentType,
          truncated: body.truncated,
          text: body.text,
        },
        null,
        2,
      ),
    };
  }
  return { ok: false, error: `too many redirects (>${MAX_WEB_REDIRECTS})` };
}

async function readCapped(response: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total >= cap) {
      chunks.push(value.subarray(0, value.byteLength - (total - cap)));
      truncated = true;
      void reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** True for global unicast addresses; false for loopback/private/link-local/etc. */
export function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return false;
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
    if (lower.startsWith('::ffff:')) return isPublicAddress(lower.slice('::ffff:'.length));
    return true;
  }
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}
