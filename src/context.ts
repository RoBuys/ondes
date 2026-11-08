import { createContext, useContext } from 'react';
import type { Catalog, Epg, PlaySpec, Settings, Source } from './lib/types';

export type View = 'live' | 'guide' | 'movies' | 'series' | 'settings';

export interface Status {
  loading: boolean;
  message?: string;
  error?: string;
}

export interface EpgStatus {
  state: 'none' | 'loading' | 'ready' | 'error';
  error?: string;
}

export interface AppCtx {
  sources: Source[];
  active: Source | null;
  setActiveId: (id: string) => void;
  addSource: (s: Source, fileText?: string) => Promise<void>;
  updateSource: (s: Source) => void;
  removeSource: (id: string) => Promise<void>;

  catalog: Catalog | null;
  status: Status;
  refresh: () => void;

  epg: Epg | null;
  epgStatus: EpgStatus;
  refreshEpg: () => void;

  settings: Settings;
  setSettings: (p: Partial<Settings>) => void;

  favs: Set<string>;
  toggleFav: (id: string) => void;

  view: View;
  setView: (v: View) => void;
  liveSel: string | null;
  setLiveSel: (id: string | null) => void;

  overlay: PlaySpec | null;
  play: (spec: PlaySpec) => void;
  clearCaches: () => Promise<void>;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('Contexte manquant');
  return c;
}
