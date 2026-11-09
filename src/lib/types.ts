export type SourceKind = 'm3u' | 'xtream';

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  /** Remote M3U */
  url?: string;
  /** M3U imported from a file (content stored in IndexedDB) */
  isFile?: boolean;
  /** Xtream Codes */
  server?: string;
  username?: string;
  password?: string;
  /** Forced XMLTV guide (otherwise the one advertised by the source) */
  epgUrl?: string;
  createdAt: number;
  /** Source hidden from the picker and from global search */
  hidden?: boolean;
  /** Tabs shown for this source (all by default) */
  sections?: Partial<Record<Section, boolean>>;
}

export type Section = 'live' | 'guide' | 'movies' | 'series';

export interface Channel {
  id: string;
  name: string;
  logo?: string;
  group: string;
  url: string;
  /** HLS variant (Xtream) */
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
  /** Present for series coming from an M3U playlist */
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
  /** XMLTV id (lowercase) → sorted programmes */
  byId: Record<string, Programme[]>;
  /** normalized name → XMLTV id (lowercase) */
  names: Record<string, string>;
  fetchedAt: number;
}

export interface Settings {
  liveFormat: 'ts' | 'm3u8';
  /** Playback engine: native mpv (default when available) or web player. */
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
  /** Forced mpegts.js settings (self-test only) */
  tsOverride?: { isLive?: boolean; config?: Record<string, unknown> };
  /** Forced engine (self-test only) */
  forceEngine?: 'hls' | 'ts' | 'native';
}
