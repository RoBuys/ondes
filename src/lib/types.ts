export type SourceKind = 'm3u' | 'xtream';

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  /** M3U distante */
  url?: string;
  /** M3U importée depuis un fichier (contenu stocké en IndexedDB) */
  isFile?: boolean;
  /** Xtream Codes */
  server?: string;
  username?: string;
  password?: string;
  /** Guide XMLTV forcé (sinon celui annoncé par la source) */
  epgUrl?: string;
  createdAt: number;
}

export interface Channel {
  id: string;
  name: string;
  logo?: string;
  group: string;
  url: string;
  /** Variante HLS (Xtream) */
  altUrl?: string;
  epgId?: string;
  num?: number;
}

export interface Movie {
  id: string;
  name: string;
  poster?: string;
  group: string;
  url: string;
  vodId?: number;
  rating?: string;
  year?: string;
}

export interface Episode {
  id: string;
  title: string;
  season: number;
  episode: number;
  url: string;
  plot?: string;
  image?: string;
  duration?: string;
}

export interface Show {
  id: string;
  name: string;
  poster?: string;
  group: string;
  seriesId?: number;
  plot?: string;
  rating?: string;
  year?: string;
  /** Présent pour les séries issues d'une M3U */
  episodes?: Episode[];
}

export interface AccountInfo {
  status?: string;
  expires?: number;
  maxConnections?: string;
  activeConnections?: string;
}

export interface Catalog {
  sourceId: string;
  live: Channel[];
  movies: Movie[];
  series: Show[];
  epgUrl?: string;
  account?: AccountInfo;
  fetchedAt: number;
}

export interface Programme {
  start: number;
  stop: number;
  title: string;
  desc?: string;
}

export interface Epg {
  /** id XMLTV (minuscules) → programmes triés */
  byId: Record<string, Programme[]>;
  /** nom normalisé → id XMLTV (minuscules) */
  names: Record<string, string>;
  fetchedAt: number;
}

export interface Settings {
  liveFormat: 'ts' | 'm3u8';
  /** Moteur de lecture : mpv natif (par défaut s'il est disponible) ou lecteur web. */
  engine?: 'mpv' | 'web';
}

export interface PlaySpec {
  key: string;
  title: string;
  subtitle?: string;
  urls: string[];
  live: boolean;
  resumeKey?: string;
  poster?: string;
  onEnded?: () => void;
  /** Réglages mpegts.js imposés (autotest uniquement) */
  tsOverride?: { isLive?: boolean; config?: Record<string, unknown> };
  /** Moteur imposé (autotest uniquement) */
  forceEngine?: 'hls' | 'ts' | 'native';
}
