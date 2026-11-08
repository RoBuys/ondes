/** Vrai dans l'app Tauri (WebView2 sous Windows). */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * En développement dans un navigateur classique, les serveurs IPTV n'envoient pas d'en-têtes CORS :
 * on passe par le proxy de Vite. Dans l'app, WebView2 est lancé sans restriction CORS.
 */
const useProxy = import.meta.env.DEV && !isTauri;

/**
 * Sur macOS, WKWebView applique le CORS et bloque le contenu http : l'app passe par un relais local
 * démarré par la partie Rust (127.0.0.1, protégé par un jeton). Préfixe des URL relayées, ou null.
 */
let nativeProxy: string | null = null;

export async function initNet() {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ port: number; token: string } | null>('proxy_info');
    if (info) nativeProxy = `http://127.0.0.1:${info.port}/proxy?t=${info.token}&url=`;
  } catch {
    /* relais indisponible : accès direct */
  }
}

const isHttp = (u: string) => /^https?:\/\//i.test(u);

/** URL à utiliser pour les requêtes réseau (fetch, hls.js, mpegts.js). */
export const proxied = (u: string) => {
  if (!isHttp(u)) return u;
  if (nativeProxy) return nativeProxy + encodeURIComponent(u);
  // URL absolue : mpegts.js charge les flux depuis un Web Worker, qui ne résout pas les chemins relatifs.
  if (useProxy) return `${location.origin}/__proxy?url=${encodeURIComponent(u)}`;
  return u;
};

/** URL pour <video src> et <img src> : relayée seulement là où c'est nécessaire (macOS). */
export const mediaSrc = (u: string) => (nativeProxy && isHttp(u) ? nativeProxy + encodeURIComponent(u) : u);

export async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  let r: Response;
  try {
    r = await fetch(proxied(url), { signal, cache: 'no-store' });
  } catch {
    throw new Error(`Serveur injoignable : ${new URL(url).host}`);
  }
  if (!r.ok) throw new Error(`Le serveur a répondu ${r.status} ${r.statusText}`.trim());
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
    throw new Error('Réponse du serveur illisible');
  }
}
