import { createContext, useContext } from 'react';
import type { ContentRules, Kind } from './lib/content';
import type { DownloadsApi } from './lib/downloads';
import type { ChannelList } from './lib/lists';
import type { Catalog, Epg, PlaySpec, Settings, Source } from './lib/types';

export type View = 'live' | 'guide' | 'movies' | 'series' | 'favorites' | 'downloads' | 'search' | 'settings';

/** Élément à ouvrir dès que le catalogue de sa source est chargé (depuis la recherche globale). */
export interface PendingOpen {
  kind: 'movie' | 'show';
  id: string;
  sourceId: string;
}

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

  /** Catalogue personnalisé (groupes masqués, renommés…) : celui qu'affichent les vues. */
  catalog: Catalog | null;
  /** Catalogue tel que fourni par la source. */
  rawCatalog: Catalog | null;
  rules: ContentRules;
  setRules: (r: ContentRules) => void;
  organize: (kind?: Kind | 'lists') => void;
  /** Ouvre la fenêtre « renommer / masquer » d'une chaîne, d'un film ou d'une série. */
  editItem: (id: string, label: string) => void;
  status: Status;
  refresh: () => void;

  epg: Epg | null;
  epgStatus: EpgStatus;
  refreshEpg: () => void;

  settings: Settings;
  setSettings: (p: Partial<Settings>) => void;

  favs: Set<string>;
  toggleFav: (id: string) => void;

  /** Listes de chaînes de la source active */
  lists: ChannelList[];
  setLists: (l: ChannelList[]) => void;

  view: View;
  setView: (v: View) => void;
  liveSel: string | null;
  setLiveSel: (id: string | null) => void;

  pendingOpen: PendingOpen | null;
  setPendingOpen: (p: PendingOpen | null) => void;
  downloads: DownloadsApi;

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
