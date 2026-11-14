import { prefs } from './store';
import { uid } from './util';
import { t } from './i18n';

/** User-created channel list ("Sport", "News"…), specific to one source. */
export interface ChannelList {
  id: string;
  name: string;
  /** Channel ids, in the chosen order */
  ids: string[];
}

/** Prefix of group ids that stand for a list in the Live and Guide views. */
export const LIST_PREFIX = '__list:';

export const loadLists = (sourceId: string) => prefs.get<ChannelList[]>(`lists.${sourceId}`, []);
export const saveLists = (sourceId: string, lists: ChannelList[]) => prefs.set(`lists.${sourceId}`, lists);

export const newList = (name: string): ChannelList => ({ id: uid(), name: name.trim() || t("Nouvelle liste"), ids: [] });

/** Adds a channel to a list or removes it. */
export function toggleInList(lists: ChannelList[], listId: string, channelId: string): ChannelList[] {
  return lists.map((l) =>
    l.id !== listId ? l : { ...l, ids: l.ids.includes(channelId) ? l.ids.filter((x) => x !== channelId) : [...l.ids, channelId] },
  );
}

/** Channels of a list, in its order (channels no longer in the playlist are skipped). */
export function channelsOf<T extends { id: string }>(list: ChannelList, byId: Map<string, T>): T[] {
  return list.ids.map((id) => byId.get(id)).filter((c): c is T => !!c);
}
