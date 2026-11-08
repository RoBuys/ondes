import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './net';

/** Masque identifiants et jetons dans une URL (chemins Xtream /live/u/p/…, paramètres username/password/t). */
export function redact(u: string): string {
  try {
    const decoded = u.includes('/proxy?') ? decodeURIComponent(u.split('url=')[1] ?? u) : u;
    return decoded
      .replace(/\/(live|movie|series|timeshift)\/[^/]+\/[^/]+\//, '/$1/***/***/')
      .replace(/([?&](?:username|password|t|token)=)[^&]*/gi, '$1***');
  } catch {
    return '(url)';
  }
}

/**
 * Journal de diagnostic du lecteur. Dans l'app, écrit aussi dans le fichier journal
 * (macOS : ~/Library/Logs/com.robertbuys.ondes/ondes.log, Windows : %LOCALAPPDATA%\com.robertbuys.ondes\logs\ondes.log).
 */
export function diag(...parts: unknown[]) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.info('[ondes]', line);
  if (isTauri) invoke('diag_log', { line }).catch(() => {});
}

let envLogged = false;

/** Capacités média du moteur web, journalisées une fois au premier lancement du lecteur. */
export function logEnvironment(extra: Record<string, unknown>) {
  if (envLogged) return;
  envLogged = true;
  const v = document.createElement('video');
  const w = window as unknown as Record<string, unknown>;
  diag('environnement', {
    ua: navigator.userAgent,
    origin: location.origin,
    MediaSource: typeof w.MediaSource,
    ManagedMediaSource: typeof w.ManagedMediaSource,
    canPlayHls: v.canPlayType('application/vnd.apple.mpegurl'),
    canPlayTs: v.canPlayType('video/mp2t'),
    canPlayMp4: v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
    ...extra,
  });
}
