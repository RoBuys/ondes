import { parseM3U, type M3UEntry } from './m3u';
import { fetchText } from './net';
import { db } from './store';
import type { Catalog, Channel, Epg, Movie, Show, Source } from './types';
import { hash } from './util';
import { parseXmltv } from './xmltv';
import { loadXtream } from './xtream';
import { t as tr } from './i18n';

const SXE = /^(.*?)[\s._\-–|:]*S(\d{1,2})[\s._-]*E(\d{1,4})\b/i;

function classify(e: M3UEntry): 'live' | 'movie' | 'series' {
  const u = e.url.toLowerCase();
  if (/\/series\//.test(u)) return 'series';
  if (/\/movies?\//.test(u)) return 'movie';
  if (/\.(mp4|mkv|avi|mov|m4v|wmv|webm)(\?|$)/.test(u)) return SXE.test(e.name) ? 'series' : 'movie';
  return 'live';
}

export async function loadCatalog(src: Source): Promise<Catalog> {
  if (src.kind === 'xtream') return loadXtream(src);

  let text: string;
  if (src.isFile) {
    const t = await db.file(src.id);
    if (t == null) throw new Error(tr("Fichier introuvable : importez à nouveau la playlist"));
    text = t;
  } else {
    text = await fetchText(src.url!);
  }
  if (!/#EXTINF/i.test(text)) throw new Error(tr("Ce contenu n'est pas une playlist M3U"));

  const { entries, epgUrl } = parseM3U(text);
  const live: Channel[] = [];
  const movies: Movie[] = [];
  const shows = new Map<string, Show>();
  const seen = new Set<string>();
  const idFor = (kind: string, url: string) => {
    let id = `${src.id}:${kind}:${hash(url)}`;
    for (let i = 2; seen.has(id); i++) id = `${src.id}:${kind}:${hash(url)}-${i}`;
    seen.add(id);
    return id;
  };

  for (const e of entries) {
    const logo = e.attrs['tvg-logo'] || undefined;
    const kind = classify(e);
    if (kind === 'live') {
      live.push({
        id: idFor('l', e.url),
        name: e.name,
        logo,
        group: e.group,
        url: e.url,
        epgId: e.attrs['tvg-id'] || undefined,
        num: Number(e.attrs['tvg-chno']) || undefined,
      });
    } else if (kind === 'movie') {
      const year = /\b(19|20)\d{2}\b/.exec(e.name)?.[0];
      movies.push({ id: idFor('m', e.url), name: e.name, poster: logo, group: e.group, url: e.url, year });
    } else {
      const m = SXE.exec(e.name);
      const showName = (m ? m[1] : e.name).replace(/[\s\-–|:]+$/, '').trim() || e.name;
      const key = `${e.group}|${showName.toLowerCase()}`;
      let show = shows.get(key);
      if (!show) {
        show = { id: `${src.id}:s:${hash(key)}`, name: showName, poster: logo, group: e.group, episodes: [] };
        shows.set(key, show);
      }
      const eps = show.episodes!;
      eps.push({
        id: idFor('e', e.url),
        title: e.name,
        season: m ? +m[2] : 1,
        episode: m ? +m[3] : eps.length + 1,
        url: e.url,
        image: logo,
      });
    }
  }
  for (const s of shows.values()) s.episodes!.sort((a, b) => a.season - b.season || a.episode - b.episode);

  return { sourceId: src.id, live, movies, series: [...shows.values()], epgUrl, fetchedAt: Date.now() };
}

export function epgUrlFor(src: Source, cat: Catalog | null): string | undefined {
  return src.epgUrl?.trim() || cat?.epgUrl || undefined;
}

export async function loadEpg(url: string, cat: Catalog): Promise<Epg> {
  const text = await fetchText(url);
  if (!/<tv\b/i.test(text.slice(0, 5000)) && !/<programme\b/i.test(text)) {
    throw new Error(tr("Ce lien ne contient pas de guide XMLTV"));
  }
  const now = Date.now();
  return parseXmltv(text, cat.live, now - 12 * 3600_000, now + 4 * 86400_000);
}
