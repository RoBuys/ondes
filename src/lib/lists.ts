import { prefs } from './store';
import { uid } from './util';

/** Liste de chaînes créée par l'utilisateur (« Sport », « Infos »…), propre à une source. */
export interface ChannelList {
  id: string;
  name: string;
  /** Identifiants des chaînes, dans l'ordre choisi */
  ids: string[];
}

/** Préfixe des identifiants de groupe correspondant à une liste dans les vues Direct et Guide. */
export const LIST_PREFIX = '__list:';

export const loadLists = (sourceId: string) => prefs.get<ChannelList[]>(`lists.${sourceId}`, []);
export const saveLists = (sourceId: string, lists: ChannelList[]) => prefs.set(`lists.${sourceId}`, lists);

export const newList = (name: string): ChannelList => ({ id: uid(), name: name.trim() || 'Nouvelle liste', ids: [] });

/** Ajoute ou retire une chaîne d'une liste. */
export function toggleInList(lists: ChannelList[], listId: string, channelId: string): ChannelList[] {
  return lists.map((l) =>
    l.id !== listId ? l : { ...l, ids: l.ids.includes(channelId) ? l.ids.filter((x) => x !== channelId) : [...l.ids, channelId] },
  );
}

/** Chaînes d'une liste, dans son ordre (celles qui n'existent plus dans la playlist sont ignorées). */
export function channelsOf<T extends { id: string }>(list: ChannelList, byId: Map<string, T>): T[] {
  return list.ids.map((id) => byId.get(id)).filter((c): c is T => !!c);
}
