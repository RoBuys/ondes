import { prefs } from './store';
import type { Catalog } from './types';

/**
 * Per-source customization: hidden, renamed, reordered groups; hidden or renamed items.
 * Group keys are prefixed with the type: "l|" channels, "m|" movies, "s|" series.
 * Giving two groups the same name merges them.
 */
export interface ContentRules {
  hiddenGroups: string[];
  groupNames: Record<string, string>;
  groupOrder: string[];
  hiddenItems: string[];
  itemNames: Record<string, string>;
}

export type Kind = 'l' | 'm' | 's';

export const emptyRules = (): ContentRules => ({ hiddenGroups: [], groupNames: {}, groupOrder: [], hiddenItems: [], itemNames: {} });

export const groupKey = (kind: Kind, group: string) => `${kind}|${group}`;

export function loadRules(sourceId: string): ContentRules {
  return { ...emptyRules(), ...prefs.get<Partial<ContentRules>>(`content.${sourceId}`, {}) };
}

export function saveRules(sourceId: string, r: ContentRules) {
  prefs.set(`content.${sourceId}`, r);
}

export function isEmptyRules(r: ContentRules) {
  return (
    !r.hiddenGroups.length &&
    !r.groupOrder.length &&
    !r.hiddenItems.length &&
    !Object.keys(r.groupNames).length &&
    !Object.keys(r.itemNames).length
  );
}

interface Base {
  id: string;
  name: string;
  group: string;
}

function applyList<T extends Base>(list: T[], kind: Kind, r: ContentRules, hg: Set<string>, hi: Set<string>, rank: Map<string, number>): T[] {
  const out: { it: T; rank: number; i: number }[] = [];
  list.forEach((it, i) => {
    const gk = groupKey(kind, it.group);
    if (hg.has(gk) || hi.has(it.id)) return;
    const name = r.itemNames[it.id];
    const group = r.groupNames[gk];
    out.push({ it: name || group ? { ...it, name: name || it.name, group: group || it.group } : it, rank: rank.get(gk) ?? Infinity, i });
  });
  if (rank.size) out.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return out.map((o) => o.it);
}

export function applyRules(cat: Catalog, r: ContentRules): Catalog {
  if (isEmptyRules(r)) return cat;
  const hg = new Set(r.hiddenGroups);
  const hi = new Set(r.hiddenItems);
  const rank = new Map(r.groupOrder.map((k, i) => [k, i]));
  return {
    ...cat,
    live: applyList(cat.live, 'l', r, hg, hi, rank),
    movies: applyList(cat.movies, 'm', r, hg, hi, rank),
    series: applyList(cat.series, 's', r, hg, hi, rank),
  };
}

/** Raw groups of a type, in effective order (custom order first). */
export function rawGroups(cat: Catalog, kind: Kind, r: ContentRules) {
  const list = kind === 'l' ? cat.live : kind === 'm' ? cat.movies : cat.series;
  const counts = new Map<string, number>();
  for (const it of list) counts.set(it.group, (counts.get(it.group) || 0) + 1);
  const rank = new Map(r.groupOrder.map((k, i) => [k, i]));
  return [...counts]
    .map(([group, count], i) => ({ group, key: groupKey(kind, group), count, i }))
    .sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity) || a.i - b.i);
}
