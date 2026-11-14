/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchJson } from './net';
import type { Catalog, Channel, Episode, Movie, Show, Source } from './types';
import { t } from './i18n';

export function xtBase(s: Pick<Source, 'server'>): string {
  let u = (s.server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/(player_api|get)\.php.*$/i, '');
}

const enc = encodeURIComponent;

function apiUrl(s: Source, action?: string, extra = '') {
  const q = `username=${enc(s.username || '')}&password=${enc(s.password || '')}`;
  return `${xtBase(s)}/player_api.php?${q}${action ? `&action=${action}` : ''}${extra}`;
}

const asArray = (x: any): any[] => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);
const str = (x: any) => (x == null ? '' : String(x)).trim();
const yearOf = (...c: any[]) => {
  for (const v of c) {
    const m = /\b(19|20)\d{2}\b/.exec(str(v));
    if (m) return m[0];
  }
  return undefined;
};

export async function xtLogin(s: Source) {
  const r = await fetchJson<any>(apiUrl(s));
  if (!r || typeof r !== 'object' || !r.user_info) throw new Error(t("Ce serveur ne répond pas comme un serveur Xtream Codes"));
  if (r.user_info.auth === 0 || r.user_info.auth === '0') throw new Error(t("Identifiant ou mot de passe incorrect"));
  return r;
}

function categories(arr: any) {
  const names = new Map<string, string>();
  const order = new Map<string, number>();
  asArray(arr).forEach((c, i) => {
    names.set(str(c.category_id), str(c.category_name) || t("Sans catégorie"));
    order.set(str(c.category_id), i);
  });
  return { name: (id: any) => names.get(str(id)) || t("Sans catégorie"), order: (id: any) => order.get(str(id)) ?? 1e9 };
}

export async function loadXtream(s: Source): Promise<Catalog> {
  const login = await xtLogin(s);
  const base = xtBase(s);
  const u = enc(s.username || '');
  const p = enc(s.password || '');
  const get = (a: string) => fetchJson<any>(apiUrl(s, a)).catch(() => []);

  const [lc, ls, vc, vs, sc, ss] = await Promise.all([
    get('get_live_categories'),
    get('get_live_streams'),
    get('get_vod_categories'),
    get('get_vod_streams'),
    get('get_series_categories'),
    get('get_series'),
  ]);

  const L = categories(lc);
  const live: Channel[] = asArray(ls)
    .map((x) => ({ x, o: L.order(x.category_id), n: Number(x.num) || 0 }))
    .sort((a, b) => a.o - b.o || a.n - b.n)
    .map(({ x }) => ({
      id: `${s.id}:l:${x.stream_id}`,
      name: str(x.name) || t("Sans nom"),
      logo: str(x.stream_icon) || undefined,
      group: L.name(x.category_id),
      url: `${base}/live/${u}/${p}/${x.stream_id}.ts`,
      altUrl: `${base}/live/${u}/${p}/${x.stream_id}.m3u8`,
      epgId: str(x.epg_channel_id) || undefined,
      num: Number(x.num) || undefined,
    }));

  const V = categories(vc);
  const movies: Movie[] = asArray(vs)
    .map((x) => ({ x, o: V.order(x.category_id) }))
    .sort((a, b) => a.o - b.o)
    .map(({ x }) => ({
      id: `${s.id}:m:${x.stream_id}`,
      name: str(x.name) || t("Sans titre"),
      poster: str(x.stream_icon) || undefined,
      group: V.name(x.category_id),
      url: `${base}/movie/${u}/${p}/${x.stream_id}.${str(x.container_extension) || 'mp4'}`,
      vodId: Number(x.stream_id),
      rating: str(x.rating) && str(x.rating) !== '0' ? str(x.rating) : undefined,
      year: yearOf(x.year, x.releasedate, x.name),
    }));

  const S = categories(sc);
  const series: Show[] = asArray(ss)
    .map((x) => ({ x, o: S.order(x.category_id) }))
    .sort((a, b) => a.o - b.o)
    .map(({ x }) => ({
      id: `${s.id}:s:${x.series_id}`,
      name: str(x.name) || t("Sans titre"),
      poster: str(x.cover) || undefined,
      group: S.name(x.category_id),
      seriesId: Number(x.series_id),
      plot: str(x.plot) || undefined,
      rating: str(x.rating) && str(x.rating) !== '0' ? str(x.rating) : undefined,
      year: yearOf(x.releaseDate, x.release_date, x.year, x.name),
    }));

  const ui = login.user_info;
  return {
    sourceId: s.id,
    live,
    movies,
    series,
    epgUrl: `${base}/xmltv.php?username=${u}&password=${p}`,
    account: {
      status: str(ui.status) || undefined,
      expires: Number(ui.exp_date) ? Number(ui.exp_date) * 1000 : undefined,
      maxConnections: str(ui.max_connections) || undefined,
      activeConnections: str(ui.active_cons) || undefined,
    },
    fetchedAt: Date.now(),
  };
}

export interface ExtraInfo {
  plot?: string;
  genre?: string;
  cast?: string;
  director?: string;
  duration?: string;
  released?: string;
  backdrop?: string;
  rating?: string;
}

function extra(info: any): ExtraInfo {
  if (!info || typeof info !== 'object') return {};
  const backdrop = asArray(info.backdrop_path)[0] || (typeof info.backdrop_path === 'string' ? info.backdrop_path : undefined);
  return {
    plot: str(info.plot || info.description) || undefined,
    genre: str(info.genre) || undefined,
    cast: str(info.cast || info.actors) || undefined,
    director: str(info.director) || undefined,
    duration: str(info.duration) || undefined,
    released: str(info.releasedate || info.releaseDate || info.release_date) || undefined,
    backdrop: str(backdrop) || undefined,
    rating: str(info.rating) && str(info.rating) !== '0' ? str(info.rating) : undefined,
  };
}

export async function xtVodInfo(s: Source, vodId: number): Promise<ExtraInfo> {
  const r = await fetchJson<any>(apiUrl(s, 'get_vod_info', `&vod_id=${vodId}`));
  return extra(r?.info);
}

export async function xtSeriesInfo(s: Source, seriesId: number): Promise<{ info: ExtraInfo; episodes: Episode[] }> {
  const r = await fetchJson<any>(apiUrl(s, 'get_series_info', `&series_id=${seriesId}`));
  const base = xtBase(s);
  const u = enc(s.username || '');
  const p = enc(s.password || '');
  const episodes: Episode[] = [];
  const groups = r?.episodes;
  const entries: [string, any][] = Array.isArray(groups)
    ? groups.map((list: any, i: number) => [String(i + 1), list])
    : Object.entries(groups || {});
  for (const [season, list] of entries) {
    for (const e of asArray(list)) {
      episodes.push({
        id: `${s.id}:e:${e.id}`,
        title: str(e.title) || t('Épisode {n}', { n: e.episode_num }),
        season: Number(e.season ?? season) || 1,
        episode: Number(e.episode_num) || 0,
        url: `${base}/series/${u}/${p}/${e.id}.${str(e.container_extension) || 'mp4'}`,
        plot: str(e.info?.plot) || undefined,
        image: str(e.info?.movie_image) || undefined,
        duration: str(e.info?.duration) || undefined,
      });
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { info: extra(r?.info), episodes };
}
