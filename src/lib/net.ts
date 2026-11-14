import { t as tr } from './i18n';
/** True in the Tauri app (WebView2 on Windows). */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * In development, in a regular browser, stream servers do not send CORS headers:
 * we go through Vite's proxy. In the app, WebView2 runs without CORS restrictions.
 */
const useProxy = import.meta.env.DEV && !isTauri;

/**
 * On macOS, WKWebView enforces CORS and blocks http content: the app goes through a local relay
 * started by the Rust side (127.0.0.1, protected by a token). Prefix of relayed URLs, or null.
 */
let nativeProxy: string | null = null;

export async function initNet() {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ port: number; token: string } | null>('proxy_info');
    if (info) nativeProxy = `http://127.0.0.1:${info.port}/proxy?t=${info.token}&url=`;
  } catch {
    /* relay unavailable: direct access */
  }
}

const isHttp = (u: string) => /^https?:\/\//i.test(u);

/** URL to use for network requests (fetch, hls.js, mpegts.js). */
export const proxied = (u: string) => {
  if (!isHttp(u)) return u;
  if (nativeProxy) return nativeProxy + encodeURIComponent(u);
  // Absolute URL: mpegts.js loads streams from a Web Worker, which does not resolve relative paths.
  if (useProxy) return `${location.origin}/__proxy?url=${encodeURIComponent(u)}`;
  return u;
};

/** URL for <video src> and <img src>: relayed only where needed (macOS). */
export const mediaSrc = (u: string) => (nativeProxy && isHttp(u) ? nativeProxy + encodeURIComponent(u) : u);

export async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  let r: Response;
  try {
    r = await fetch(proxied(url), { signal, cache: 'no-store' });
  } catch {
    throw new Error(tr('Serveur injoignable : {host}', { host: new URL(url).host }));
  }
  if (!r.ok) throw new Error(tr('Le serveur a répondu {status}', { status: `${r.status} ${r.statusText}`.trim() }));
  return new Uint8Array(await r.arrayBuffer());
}

async function gunzipIfNeeded(b: Uint8Array): Promise<Uint8Array> {
  if (b[0] === 0x1f && b[1] === 0x8b) {
    const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return b;
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const b = await gunzipIfNeeded(await fetchBytes(url, signal));
  return new TextDecoder('utf-8').decode(b);
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const t = await fetchText(url, signal);
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new Error(tr("Réponse du serveur illisible"));
  }
}
