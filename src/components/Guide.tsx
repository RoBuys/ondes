import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context';
import { prefs } from '../lib/store';
import type { Channel, Programme } from '../lib/types';
import { cx, fmtDay, fmtTime } from '../lib/util';
import { programmesFor } from '../lib/xmltv';
import { ALL, channelsForGroup, FAV, useLiveGroups } from './Live';
import { Empty, Icon, Img, Modal, useNow } from './ui';

const PX = 4.5; // pixels par minute
const ROW = 60;
const HEAD = 38;
const LEFT = 210;
const SPAN_H = 12;
const MIN = 60_000;

export function GuideView() {
  const { catalog, epg, epgStatus, favs, lists, setLiveSel, setView, active, refreshEpg } = useApp();
  const live = catalog?.live ?? [];
  const groups = useLiveGroups(live, favs, lists);
  const groupKey = `guideGroup.${active?.id}`;
  const [group, setGroupState] = useState<string>(() => prefs.get(groupKey, favs.size ? FAV : ALL));
  const [shiftH, setShiftH] = useState(0);
  const [detail, setDetail] = useState<{ ch: Channel; p: Programme } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(800);
  const scroller = useRef<HTMLDivElement>(null);
  const now = useNow(60000);

  const setGroup = (g: string) => {
    setGroupState(g);
    prefs.set(groupKey, g);
    if (scroller.current) scroller.current.scrollTop = 0;
  };

  const rows = useMemo(() => channelsForGroup(live, group, favs, lists), [live, group, favs, lists]);

  const start = Math.floor(now / (30 * MIN)) * 30 * MIN - 30 * MIN + shiftH * 3600_000;
  const end = start + SPAN_H * 3600_000;
  const width = SPAN_H * 60 * PX;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [epg]);

  if (!catalog) return null;
  if (!epg) {
    return (
      <Empty title="Guide des programmes indisponible" icon="guide">
        {epgStatus.state === 'loading' ? (
          <p>Chargement du guide…</p>
        ) : (
          <>
            <p>
              {epgStatus.error ??
                'Cette source n’annonce pas de guide XMLTV. Ajoutez une adresse de guide dans les réglages de la source.'}
            </p>
            {epgStatus.error && (
              <button className="btn" onClick={refreshEpg}>
                <Icon name="refresh" size={16} /> Réessayer
              </button>
            )}
          </>
        )}
      </Empty>
    );
  }

  const first = Math.max(0, Math.floor((scrollTop - HEAD) / ROW) - 4);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 4);
  const ticks: number[] = [];
  for (let t = start; t < end; t += 30 * MIN) ticks.push(t);
  const nowX = ((now - start) / MIN) * PX;

  const open = (ch: Channel, p: Programme) => {
    if (p.start <= now && now < p.stop) {
      setLiveSel(ch.id);
      setView('live');
    } else setDetail({ ch, p });
  };

  return (
    <div className="guide">
      <div className="guide-bar">
        <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label} ({g.count})
            </option>
          ))}
        </select>
        <div className="guide-nav">
          <button className="icon-btn" onClick={() => setShiftH((h) => h - 3)} aria-label="Plus tôt">
            <Icon name="left" />
          </button>
          <button className="btn ghost" onClick={() => setShiftH(0)} disabled={shiftH === 0}>
            Maintenant
          </button>
          <button className="icon-btn" onClick={() => setShiftH((h) => h + 3)} aria-label="Plus tard">
            <Icon name="right" />
          </button>
        </div>
        <span className="guide-day">{fmtDay(Math.max(start, now))}</span>
      </div>

      {rows.length === 0 ? (
        <div className="pane-empty">{group === FAV ? 'Aucun favori pour l’instant.' : 'Groupe vide.'}</div>
      ) : (
        <div className="guide-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ width: LEFT + width, height: HEAD + rows.length * ROW, position: 'relative' }}>
            <div className="g-head" style={{ width: LEFT + width, height: HEAD }}>
              <div className="g-corner" style={{ width: LEFT }} />
              {ticks.map((t) => (
                <div key={t} className="g-tick" style={{ left: LEFT + ((t - start) / MIN) * PX }}>
                  {fmtTime(t)}
                </div>
              ))}
            </div>

            {rows.slice(first, last).map((ch, k) => {
              const i = first + k;
              const progs = programmesFor(epg, ch).filter((p) => p.stop > start && p.start < end);
              return (
                <div key={ch.id} className="g-row" style={{ top: HEAD + i * ROW, height: ROW, width: LEFT + width }}>
                  <button
                    className="g-ch"
                    style={{ width: LEFT }}
                    onClick={() => {
                      setLiveSel(ch.id);
                      setView('live');
                    }}
                  >
                    <Img className="g-logo" src={ch.logo} alt={ch.name} />
                    <span>{ch.name}</span>
                  </button>
                  {progs.length === 0 && (
                    <div className="g-none" style={{ left: LEFT + 6 }}>
                      Pas de programme
                    </div>
                  )}
                  {progs.map((p) => {
                    const x0 = Math.max(p.start, start);
                    const x1 = Math.min(p.stop, end);
                    const isNow = p.start <= now && now < p.stop;
                    return (
                      <button
                        key={p.start}
                        className={cx('g-prog', isNow && 'now', p.stop <= now && 'past')}
                        style={{ left: LEFT + ((x0 - start) / MIN) * PX, width: Math.max(2, ((x1 - x0) / MIN) * PX - 3) }}
                        onClick={() => open(ch, p)}
                        title={`${fmtTime(p.start)} – ${fmtTime(p.stop)}  ${p.title}`}
                      >
                        <span className="g-title">{p.title}</span>
                        <span className="g-time">
                          {fmtTime(p.start)} – {fmtTime(p.stop)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {nowX > 0 && nowX < width && (
              <div className="g-now" style={{ left: LEFT + nowX, top: HEAD - 6, height: rows.length * ROW + 6 }} />
            )}
          </div>
        </div>
      )}

      {detail && (
        <Modal onClose={() => setDetail(null)} className="prog-modal">
          <div className="muted">
            {detail.ch.name} · {fmtDay(detail.p.start)}
          </div>
          <h2>{detail.p.title}</h2>
          <div className="now-time">
            {fmtTime(detail.p.start)} – {fmtTime(detail.p.stop)} · {Math.round((detail.p.stop - detail.p.start) / MIN)} min
          </div>
          {detail.p.desc && <p className="now-desc">{detail.p.desc}</p>}
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                setLiveSel(detail.ch.id);
                setView('live');
              }}
            >
              <Icon name="play" size={16} filled /> Regarder la chaîne
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
