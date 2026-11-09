import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from './net';
import { prefs } from './store';

/** Access to the native mpv engine (Rust side, src-tauri/src/mpv.rs). */

export interface MpvTrack {
  id: number | null;
  type: 'video' | 'audio' | 'sub' | null;
  lang: string | null;
  title: string | null;
  codec: string | null;
  selected: boolean;
  channels: string | null;
}

export interface MpvEndFile {
  event: 'end-file';
  reason: 'eof' | 'stop' | 'quit' | 'error' | 'redirect' | 'other';
  error: string | null;
}

export type MpvEvent = { event: 'start-file' | 'file-loaded' | 'playback-restart' } | MpvEndFile;

let ready: Promise<{ version: string; hwdec: string | null } | null> | null = null;
let info: { version: string; hwdec: string | null } | null = null;

/** Loaded mpv version (null if unavailable). */
export const mpvInfo = () => info;

/** mpv is used if the library is loaded and the setting does not force the web player. */
export const mpvEnabled = () => info != null && prefs.settings().engine !== 'web';

/** Starts mpv only once; null if libmpv is unavailable (the web player is kept). */
export function mpvInit() {
  if (!isTauri) return Promise.resolve(null);
  ready ??= invoke<{ version: string; hwdec: string | null }>('mpv_init')
    .then((r) => (info = r))
    .catch((e) => {
      console.warn('mpv indisponible :', e);
      return null;
    });
  return ready;
}

export const mpv = {
  command: (...args: (string | number)[]) => invoke<void>('mpv_command', { args: args.map(String) }),
  set: (name: string, value: string | number | boolean) =>
    invoke<void>('mpv_set', { name, value: typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value) }),
  get: (name: string) => invoke<string | null>('mpv_get', { name }),
  tracks: () => invoke<MpvTrack[]>('mpv_tracks'),
  margins: (m: { left: number; right: number; top: number; bottom: number }) => invoke<void>('mpv_margins', m),
  debugViews: () => invoke<string[]>('mpv_debug_views'),
  onProp: (fn: (name: string, value: unknown) => void) => subscribe(propSubs, fn),
  onEvent: (fn: (e: MpvEvent) => void) => subscribe(eventSubs, fn),
  onLog: (fn: (line: string) => void) => subscribe(logSubs, fn),
};

/* A single shared Tauri listener per event type: mpv reports its position several times per second, and
   listeners added then removed on every playback would trigger bursts of warnings. */
type Fn = (...a: never[]) => void;
const propSubs = new Set<(name: string, value: unknown) => void>();
const eventSubs = new Set<(e: MpvEvent) => void>();
const logSubs = new Set<(line: string) => void>();
let listening = false;

function startListening() {
  if (listening || !isTauri) return;
  listening = true;
  listen<{ name: string; value: unknown }>('mpv-prop', (e) => propSubs.forEach((f) => f(e.payload.name, e.payload.value)));
  listen<MpvEvent>('mpv-event', (e) => eventSubs.forEach((f) => f(e.payload)));
  listen<string>('mpv-log', (e) => logSubs.forEach((f) => f(e.payload)));
}

function subscribe<F extends Fn>(set: Set<F>, fn: F): Promise<() => void> {
  startListening();
  set.add(fn);
  return Promise.resolve(() => void set.delete(fn));
}
