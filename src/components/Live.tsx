import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context';
import { prefs } from '../lib/store';
import type { Channel, PlaySpec, Settings } from '../lib/types';
import { cx, fmtTime, makeSearch } from '../lib/util';
import { nowAndNext, programmesFor, progressOf } from '../lib/xmltv';
import { Player } from './Player';
import { Empty, GroupList, Icon, Img, SearchBox, useNow, VirtualList, type GroupItem } from './ui';

export const FAV = '__fav';
export const ALL = '__all';

export function channelSpec(ch: Channel, settings: Settings): PlaySpec {
  const urls = ch.altUrl ? (settings.liveFormat === 'm3u8' ? [ch.altUrl, ch.url] : [ch.url, ch.altUrl]) : [ch.url];
  return { key: `${ch.id}|${settings.liveFormat}`, title: ch.name, subtitle: ch.group, urls, live: true };
}

export function useLiveGroups(live: Channel[], favs: Set<string>): GroupItem[] {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of live) counts.set(c.group, (counts.get(c.group) || 0) + 1);
    const favCount = live.reduce((n, c) => n + (favs.has(c.id) ? 1 : 0), 0);
    return [
      { id: FAV, label: 'Favoris', count: favCount, icon: 'star' },
      { id: ALL, label: 'Toutes les chaînes', count: live.length, icon: 'tv' },
      ...[...counts].map(([g, n]) => ({ id: g, label: g, count: n })),
    ];
  }, [live, favs]);
}

export function LiveView() {
  const { catalog, epg, favs, toggleFav, liveSel, setLiveSel, overlay, settings, active } = useApp();
  const live = catalog?.live ?? [];
  const groupKey = `liveGroup.${active?.id}`;
  const [group, setGroupState] = useState<string>(() => prefs.get(groupKey, ALL));
  const [q, setQ] = useState('');
  const now = useNow(30000);
  const groups = useLiveGroups(live, favs);

  useEffect(() => setGroupState(prefs.get(groupKey, ALL)), [groupKey]);
  const setGroup = (g: string) => {
    setGroupState(g);
    setQ('');
    prefs.set(groupKey, g);
  };

  const list = useMemo(() => {
    const s = makeSearch(q);
    if (s) return live.filter((c) => s(c.name));
    if (group === FAV) return live.filter((c) => favs.has(c.id));
    if (group === ALL) return live;
    return live.filter((c) => c.group === group);
  }, [live, group, q, favs]);

  const byId = useMemo(() => new Map(live.map((c) => [c.id, c])), [live]);
  const sel = liveSel ? byId.get(liveSel) : undefined;
  const selIndex = sel ? list.indexOf(sel) : -1;

  /* Zapping au clavier : ↑ ↓ */
  useEffect(() => {
    if (overlay) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (!list.length) return;
      e.preventDefault();
      const i = selIndex < 0 ? 0 : selIndex + (e.key === 'ArrowDown' ? 1 : -1);
      const next = list[(i + list.length) % list.length];
      setLiveSel(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list, selIndex, setLiveSel, overlay]);

  if (!catalog) return null;
  if (!live.length) {
    return (
      <Empty title="Aucune chaîne en direct" icon="tv">
        Cette source ne contient que des films ou des séries.
      </Empty>
    );
  }

  const progs = sel ? programmesFor(epg, sel) : [];
  const { cur, upcoming } = nowAndNext(progs, now);

  return (
    <div className="live">
      <GroupList groups={groups} value={q ? '' : group} onChange={setGroup} />

      <div className="channels">
        <div className="pane-head">
          <SearchBox value={q} onChange={setQ} placeholder="Rechercher une chaîne" />
        </div>
        {list.length === 0 ? (
          <div className="pane-empty">
            {q ? 'Aucune chaîne ne correspond.' : group === FAV ? 'Ajoutez des favoris avec l’étoile.' : 'Groupe vide.'}
          </div>
        ) : (
          <VirtualList
            items={list}
            rowHeight={64}
            resetKey={`${group}|${q}`}
            ensureVisible={selIndex}
            render={(ch, i) => {
              const p = programmesFor(epg, ch);
              const c = nowAndNext(p, now).cur;
              const on = favs.has(ch.id);
              return (
                <div className={cx('ch-row', ch.id === liveSel && 'on')} onClick={() => setLiveSel(ch.id)}>
                  <span className="ch-num">{ch.num ?? i + 1}</span>
                  <Img className="ch-logo" src={ch.logo} alt={ch.name} />
                  <div className="ch-text">
                    <div className="ch-name">{ch.name}</div>
                    {c ? (
                      <div className="ch-prog">
                        <span>{c.title}</span>
                        <div className="bar">
                          <i style={{ width: `${progressOf(c, now) * 100}%` }} />
                        </div>
                      </div>
                    ) : (
                      <div className="ch-prog muted">{q ? ch.group : ''}</div>
                    )}
                  </div>
                  <button
                    className={cx('fav', on && 'on')}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFav(ch.id);
                    }}
                    aria-label={on ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                  >
                    <Icon name="star" size={17} filled={on} />
                  </button>
                </div>
              );
            }}
          />
        )}
      </div>

      <div className="stage">
        {sel ? (
          <>
            <div className="stage-video">
              {overlay ? <div className="player inline paused" /> : <Player spec={channelSpec(sel, settings)} mode="inline" />}
            </div>
            <div className="stage-info">
              <div className="stage-head">
                <Img className="stage-logo" src={sel.logo} alt={sel.name} />
                <div className="stage-titles">
                  <h2>{sel.name}</h2>
                  <div className="muted">{sel.group}</div>
                </div>
                <button className={cx('btn ghost', favs.has(sel.id) && 'active')} onClick={() => toggleFav(sel.id)}>
                  <Icon name="star" size={16} filled={favs.has(sel.id)} />
                  {favs.has(sel.id) ? 'Favori' : 'Ajouter aux favoris'}
                </button>
              </div>
              {cur ? (
                <div className="now-card">
                  <div className="now-time">
                    <span className="live-dot" /> En ce moment · {fmtTime(cur.start)} – {fmtTime(cur.stop)}
                  </div>
                  <div className="now-title">{cur.title}</div>
                  <div className="bar big">
                    <i style={{ width: `${progressOf(cur, now) * 100}%` }} />
                  </div>
                  {cur.desc && <p className="now-desc">{cur.desc}</p>}
                </div>
              ) : (
                <div className="now-card muted">{epg ? 'Pas de programme pour cette chaîne.' : 'Aucun guide des programmes chargé.'}</div>
              )}
              {upcoming.length > 0 && (
                <div className="upnext">
                  <div className="section-label">À suivre</div>
                  {upcoming.map((p) => (
                    <div className="upnext-row" key={p.start}>
                      <span className="upnext-time">{fmtTime(p.start)}</span>
                      <span className="upnext-title">{p.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <Empty title="Choisissez une chaîne" icon="tv">
            Cliquez sur une chaîne pour la regarder. Les flèches ↑ ↓ permettent de zapper.
          </Empty>
        )}
      </div>
    </div>
  );
}
