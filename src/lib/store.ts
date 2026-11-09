import { del, get, keys, set } from 'idb-keyval';
import type { Catalog, Epg, Settings, Source } from './types';

const P = 'ondes.';

function lsGet<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(P + k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(k: string, v: unknown) {
  try {
    localStorage.setItem(P + k, JSON.stringify(v));
  } catch {
    /* storage full or unavailable */
  }
}

export const prefs = {
  sources: () => lsGet<Source[]>('sources', []),
  setSources: (s: Source[]) => lsSet('sources', s),
  activeId: () => lsGet<string | null>('active', null),
  setActiveId: (id: string | null) => lsSet('active', id),
  settings: (): Settings => ({ liveFormat: 'ts', ...lsGet<Partial<Settings>>('settings', {}) }),
  setSettings: (s: Settings) => lsSet('settings', s),
  favorites: () => new Set(lsGet<string[]>('favorites', [])),
  setFavorites: (s: Set<string>) => lsSet('favorites', [...s]),
  volume: () => lsGet<number>('volume', 1),
  setVolume: (v: number) => lsSet('volume', v),
  get: lsGet,
  set: lsSet,
};

/* Playback positions (movies, episodes) */
export interface Position {
  t: number;
  d: number;
  at: number;
}

export function getPositions(): Record<string, Position> {
  return lsGet<Record<string, Position>>('positions', {});
}

export function getPosition(key: string): Position | undefined {
  return getPositions()[key];
}

export function setPosition(key: string, t: number, d: number) {
  const all = getPositions();
  all[key] = { t, d, at: Date.now() };
  const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
  lsSet('positions', Object.fromEntries(entries));
}

export function clearPosition(key: string) {
  const all = getPositions();
  delete all[key];
  lsSet('positions', all);
}

/* Large data: IndexedDB */
export const db = {
  catalog: (id: string) => get<Catalog>(`cat:${id}`).catch(() => undefined),
  setCatalog: (c: Catalog) => set(`cat:${c.sourceId}`, c).catch(() => {}),
  epg: (id: string) => get<Epg>(`epg:${id}`).catch(() => undefined),
  setEpg: (id: string, e: Epg) => set(`epg:${id}`, e).catch(() => {}),
  file: (id: string) => get<string>(`file:${id}`).catch(() => undefined),
  setFile: (id: string, text: string) => set(`file:${id}`, text),
  async removeSource(id: string) {
    await Promise.all([del(`cat:${id}`), del(`epg:${id}`), del(`file:${id}`)]).catch(() => {});
  },
  async clearCaches() {
    const all = await keys().catch(() => []);
    await Promise.all(
      all.filter((k) => typeof k === 'string' && (k.startsWith('cat:') || k.startsWith('epg:'))).map((k) => del(k)),
    ).catch(() => {});
  },
};
