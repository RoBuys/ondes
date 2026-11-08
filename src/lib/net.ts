/** Vrai dans l'app Tauri (WebView2 sous Windows). */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * En développement dans un navigateur classique, les serveurs IPTV n'envoient pas d'en-têtes CORS :
 * on passe par le proxy de Vite. Dans l'app, WebView2 est lancé sans restriction CORS.
 */
const useProxy = import.meta.env.DEV && !isTauri;

export const proxied = (u: string) =>
  // URL absolue : mpegts.js charge les flux depuis un Web Worker, qui ne résout pas les chemins relatifs.
  useProxy && /^https?:\/\//i.test(u) ? `${location.origin}/__proxy?url=${encodeURIComponent(u)}` : u;

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
