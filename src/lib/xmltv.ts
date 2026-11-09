import type { Channel, Epg, Programme } from './types';
import { normName } from './util';

/** "20261108203000 +0100" → timestamp in ms */
export function parseXmltvDate(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s.trim());
  if (!m) return NaN;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    t -= sign * (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * 60000;
  }
  return t;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    })
    .trim();
}

function attr(a: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(a);
  return m ? decodeXml(m[1]) : undefined;
}

/**
 * Parses an XMLTV guide, keeping only the playlist's channels and the [from, to] window.
 * Guides are often tens of MB: we filter as early as possible.
 */
export function parseXmltv(text: string, channels: Channel[], from: number, to: number): Epg {
  const names: Record<string, string> = {};
  for (const m of text.matchAll(/<channel\b[^>]*?\bid\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g)) {
    const id = decodeXml(m[1]).toLowerCase();
    for (const d of m[2].matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)) {
      const n = normName(decodeXml(d[1]));
      if (n && !(n in names)) names[n] = id;
    }
  }

  const wanted = new Set<string>();
  for (const ch of channels) {
    if (ch.epgId) {
      const id = ch.epgId.toLowerCase();
      wanted.add(id);
      wanted.add(id.split('@')[0]);
    }
    const byName = names[normName(ch.name)];
    if (byName) wanted.add(byName);
  }

  const byId: Record<string, Programme[]> = {};
  for (const m of text.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const a = m[1];
    const ch = attr(a, 'channel')?.toLowerCase();
    if (!ch || !wanted.has(ch)) continue;
    const start = parseXmltvDate(attr(a, 'start') ?? '');
    const stop = parseXmltvDate(attr(a, 'stop') ?? '');
    if (!(stop > from) || !(start < to)) continue;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]);
    const desc = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(m[2]);
    (byId[ch] ||= []).push({
      start,
      stop,
      title: title ? decodeXml(title[1]) : 'Sans titre',
      desc: desc ? decodeXml(desc[1]) : undefined,
    });
  }

  for (const id of Object.keys(byId)) {
    const list = byId[id].sort((x, y) => x.start - y.start);
    byId[id] = list.filter((p, i) => i === 0 || p.start >= list[i - 1].start + 60000);
  }

  // Only names that have programmes are kept in the name index.
  const usedNames: Record<string, string> = {};
  for (const [n, id] of Object.entries(names)) if (byId[id]) usedNames[n] = id;

  return { byId, names: usedNames, fetchedAt: Date.now() };
}

const EMPTY: Programme[] = [];

export function programmesFor(epg: Epg | null, ch: Channel): Programme[] {
  if (!epg) return EMPTY;
  const id = ch.epgId?.toLowerCase();
  if (id) {
    const hit = epg.byId[id] ?? epg.byId[id.split('@')[0]];
    if (hit) return hit;
  }
  const byName = epg.names[normName(ch.name)];
  return (byName && epg.byId[byName]) || EMPTY;
}

export function currentIndex(list: Programme[], now: number): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].stop <= now) lo = mid + 1;
    else if (list[mid].start > now) hi = mid - 1;
    else return mid;
  }
  return -1;
}

export function nowAndNext(list: Programme[], now: number) {
  const i = currentIndex(list, now);
  if (i >= 0) return { cur: list[i], upcoming: list.slice(i + 1, i + 7) };
  const nextIdx = list.findIndex((p) => p.start > now);
  return { cur: undefined, upcoming: nextIdx >= 0 ? list.slice(nextIdx, nextIdx + 6) : [] };
}

export const progressOf = (p: Programme, now: number) =>
  Math.max(0, Math.min(1, (now - p.start) / (p.stop - p.start)));
