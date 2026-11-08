import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context';
import { getPosition, getPositions } from '../lib/store';
import type { Episode, Movie, Show } from '../lib/types';
import { cx, errMsg, makeSearch } from '../lib/util';
import { xtSeriesInfo, xtVodInfo, type ExtraInfo } from '../lib/xtream';
import { Empty, GroupList, Icon, Img, Modal, SearchBox, copyText, type GroupItem } from './ui';

const FAV = '__fav';
const ALL = '__all';
const CONT = '__cont';
const PAGE = 120;

type Item = Movie | Show;

function useGroups<T extends Item>(items: T[], favs: Set<string>, contIds: Set<string> | null): GroupItem[] {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of items) counts.set(m.group, (counts.get(m.group) || 0) + 1);
    const out: GroupItem[] = [];
    if (contIds) {
      const n = items.reduce((k, m) => k + (contIds.has(m.id) ? 1 : 0), 0);
      if (n) out.push({ id: CONT, label: 'Continuer', count: n, icon: 'play' });
    }
    out.push(
      { id: FAV, label: 'Favoris', count: items.reduce((k, m) => k + (favs.has(m.id) ? 1 : 0), 0), icon: 'star' },
      { id: ALL, label: 'Tout', count: items.length, icon: 'film' },
      ...[...counts].map(([g, n]) => ({ id: g, label: g, count: n })),
    );
    return out;
  }, [items, favs, contIds]);
}

function Browser<T extends Item>({
  items,
  kind,
  contIds,
  onOpen,
}: {
  items: T[];
  kind: 'movies' | 'series';
  contIds: Set<string> | null;
  onOpen: (it: T) => void;
}) {
  const { favs } = useApp();
  const groups = useGroups(items, favs, contIds);
  const [group, setGroup] = useState(ALL);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const list = useMemo(() => {
    const s = makeSearch(q);
    if (s) return items.filter((m) => s(m.name));
    if (group === FAV) return items.filter((m) => favs.has(m.id));
    if (group === CONT && contIds) return items.filter((m) => contIds.has(m.id));
    if (group === ALL) return items;
    return items.filter((m) => m.group === group);
  }, [items, group, q, favs, contIds]);

  useEffect(() => setLimit(PAGE), [group, q]);

  if (!items.length) {
    return (
      <Empty title={kind === 'movies' ? 'Aucun film' : 'Aucune série'} icon={kind === 'movies' ? 'film' : 'series'}>
        Cette source ne propose pas de {kind === 'movies' ? 'films' : 'séries'}.
      </Empty>
    );
  }

  return (
    <div className="vod">
      <GroupList groups={groups} value={q ? '' : group} onChange={(g) => (setGroup(g), setQ(''))} />
      <div className="vod-main">
        <div className="pane-head">
          <SearchBox value={q} onChange={setQ} placeholder={kind === 'movies' ? 'Rechercher un film' : 'Rechercher une série'} />
          <span className="muted small">{list.length.toLocaleString('fr-FR')} titres</span>
        </div>
        <div
          className="poster-scroll"
          key={`${group}|${q}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 600 && limit < list.length) setLimit((l) => l + PAGE);
          }}
        >
          {list.length === 0 ? (
            <div className="pane-empty">{q ? 'Aucun résultat.' : 'Rien ici pour l’instant.'}</div>
          ) : (
            <div className="poster-grid">
              {list.slice(0, limit).map((m) => (
                <PosterCard key={m.id} item={m} onOpen={() => onOpen(m)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PosterCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const { favs } = useApp();
  const pos = getPosition(item.id);
  return (
    <button className="poster" onClick={onOpen}>
      <div className="poster-img">
        <Img src={item.poster} alt={item.name} />
        {favs.has(item.id) && (
          <span className="poster-fav">
            <Icon name="star" size={14} filled />
          </span>
        )}
        {item.rating && <span className="poster-rating">{item.rating}</span>}
        {pos && pos.d > 0 && (
          <div className="bar poster-bar">
            <i style={{ width: `${(pos.t / pos.d) * 100}%` }} />
          </div>
        )}
      </div>
      <div className="poster-name">{item.name}</div>
      {item.year && <div className="poster-year">{item.year}</div>}
    </button>
  );
}

/* ---------------- Films ---------------- */

export function MoviesView() {
  const { catalog } = useApp();
  const [open, setOpen] = useState<Movie | null>(null);
  const contIds = useMemo(() => new Set(Object.keys(getPositions())), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!catalog) return null;
  return (
    <>
      <Browser items={catalog.movies} kind="movies" contIds={contIds} onOpen={setOpen} />
      {open && <MovieDetail movie={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function MovieDetail({ movie, onClose }: { movie: Movie; onClose: () => void }) {
  const { active, play, favs, toggleFav, overlay } = useApp();
  const [info, setInfo] = useState<ExtraInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!active || active.kind !== 'xtream' || !movie.vodId) return;
    let off = false;
    xtVodInfo(active, movie.vodId)
      .then((i) => !off && setInfo(i))
      .catch((e) => !off && setErr(errMsg(e)));
    return () => {
      off = true;
    };
  }, [active, movie.vodId]);

  const pos = overlay ? undefined : getPosition(movie.id);
  const start = () =>
    play({ key: movie.id, title: movie.name, subtitle: movie.year, urls: [movie.url], live: false, resumeKey: movie.id, poster: info?.backdrop });

  const meta = [movie.year, info?.genre, info?.duration, (info?.rating || movie.rating) && `★ ${info?.rating || movie.rating}`].filter(Boolean);

  return (
    <Modal onClose={onClose} className="detail">
      {info?.backdrop && <div className="detail-backdrop" style={{ backgroundImage: `url("${info.backdrop}")` }} />}
      <div className="detail-body">
        <Img className="detail-poster" src={movie.poster} alt={movie.name} />
        <div className="detail-text">
          <div className="muted small">{movie.group}</div>
          <h2>{movie.name}</h2>
          {meta.length > 0 && <div className="detail-meta">{meta.join(' · ')}</div>}
          <div className="row">
            <button className="btn" onClick={start}>
              <Icon name="play" size={16} filled /> {pos ? 'Reprendre' : 'Lecture'}
            </button>
            <button className={cx('btn ghost', favs.has(movie.id) && 'active')} onClick={() => toggleFav(movie.id)}>
              <Icon name="star" size={16} filled={favs.has(movie.id)} /> {favs.has(movie.id) ? 'Favori' : 'Favoris'}
            </button>
            <button
              className="btn ghost"
              onClick={async () => {
                if (await copyText(movie.url)) setCopied(true);
              }}
              title="Pour l’ouvrir dans un autre lecteur (VLC…)"
            >
              <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Copiée' : 'Copier le lien'}
            </button>
          </div>
          {pos && pos.d > 0 && (
            <div className="resume">
              <div className="bar">
                <i style={{ width: `${(pos.t / pos.d) * 100}%` }} />
              </div>
              <span className="muted small">Arrêté à {Math.floor(pos.t / 60)} min sur {Math.round(pos.d / 60)}</span>
            </div>
          )}
          {info?.plot && <p className="detail-plot">{info.plot}</p>}
          {info?.director && (
            <p className="small">
              <span className="muted">Réalisation : </span>
              {info.director}
            </p>
          )}
          {info?.cast && (
            <p className="small">
              <span className="muted">Avec : </span>
              {info.cast}
            </p>
          )}
          {err && <p className="muted small">Détails indisponibles ({err}).</p>}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Séries ---------------- */

export function SeriesView() {
  const { catalog } = useApp();
  const [open, setOpen] = useState<Show | null>(null);
  if (!catalog) return null;
  return (
    <>
      <Browser items={catalog.series} kind="series" contIds={null} onOpen={setOpen} />
      {open && <ShowDetail show={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ShowDetail({ show, onClose }: { show: Show; onClose: () => void }) {
  const { active, play, favs, toggleFav, overlay } = useApp();
  const [episodes, setEpisodes] = useState<Episode[] | null>(show.episodes ?? null);
  const [info, setInfo] = useState<ExtraInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);

  useEffect(() => {
    if (show.episodes || !active || active.kind !== 'xtream' || !show.seriesId) return;
    let off = false;
    xtSeriesInfo(active, show.seriesId)
      .then((r) => {
        if (off) return;
        setEpisodes(r.episodes);
        setInfo(r.info);
      })
      .catch((e) => !off && setErr(errMsg(e)));
    return () => {
      off = true;
    };
  }, [active, show]);

  const seasons = useMemo(() => [...new Set((episodes ?? []).map((e) => e.season))].sort((a, b) => a - b), [episodes]);
  const positions = useMemo(() => getPositions(), [overlay]); // eslint-disable-line react-hooks/exhaustive-deps
  const resumeEp = useMemo(() => {
    if (!episodes) return undefined;
    let best: Episode | undefined;
    let at = 0;
    for (const e of episodes) if (positions[e.id] && positions[e.id].at > at) (best = e), (at = positions[e.id].at);
    return best;
  }, [episodes, positions]);

  const current = season ?? resumeEp?.season ?? seasons[0];
  const list = (episodes ?? []).filter((e) => e.season === current);

  const playEp = (ep: Episode) => {
    const all = episodes ?? [];
    const i = all.indexOf(ep);
    const next = all[i + 1];
    play({
      key: ep.id,
      title: show.name,
      subtitle: `S${ep.season} · É${ep.episode} — ${ep.title}`,
      urls: [ep.url],
      live: false,
      resumeKey: ep.id,
      poster: ep.image || info?.backdrop,
      onEnded: next ? () => playEp(next) : undefined,
    });
  };

  const plot = info?.plot || show.plot;
  const meta = [show.year, info?.genre, (info?.rating || show.rating) && `★ ${info?.rating || show.rating}`].filter(Boolean);

  return (
    <Modal onClose={onClose} className="detail">
      {info?.backdrop && <div className="detail-backdrop" style={{ backgroundImage: `url("${info.backdrop}")` }} />}
      <div className="detail-body">
        <Img className="detail-poster" src={show.poster} alt={show.name} />
        <div className="detail-text">
          <div className="muted small">{show.group}</div>
          <h2>{show.name}</h2>
          {meta.length > 0 && <div className="detail-meta">{meta.join(' · ')}</div>}
          <div className="row">
            {episodes && episodes.length > 0 && (
              <button className="btn" onClick={() => playEp(resumeEp ?? episodes[0])}>
                <Icon name="play" size={16} filled />
                {resumeEp ? `Reprendre S${resumeEp.season} É${resumeEp.episode}` : 'Premier épisode'}
              </button>
            )}
            <button className={cx('btn ghost', favs.has(show.id) && 'active')} onClick={() => toggleFav(show.id)}>
              <Icon name="star" size={16} filled={favs.has(show.id)} /> {favs.has(show.id) ? 'Favori' : 'Favoris'}
            </button>
          </div>
          {plot && <p className="detail-plot">{plot}</p>}
          {info?.cast && (
            <p className="small">
              <span className="muted">Avec : </span>
              {info.cast}
            </p>
          )}
        </div>
      </div>

      <div className="episodes">
        {err && <div className="pane-empty">Impossible de charger les épisodes : {err}</div>}
        {!episodes && !err && (
          <div className="pane-empty">
            <span className="spinner" /> Chargement des épisodes…
          </div>
        )}
        {episodes && episodes.length === 0 && <div className="pane-empty">Aucun épisode disponible.</div>}
        {seasons.length > 1 && (
          <div className="seasons">
            {seasons.map((s) => (
              <button key={s} className={cx('chip', s === current && 'on')} onClick={() => setSeason(s)}>
                Saison {s}
              </button>
            ))}
          </div>
        )}
        {list.map((ep) => {
          const p = positions[ep.id];
          return (
            <button key={ep.id} className="ep" onClick={() => playEp(ep)}>
              <div className="ep-img">
                <Img src={ep.image || show.poster} alt={ep.title} />
                <span className="ep-play">
                  <Icon name="play" size={18} filled />
                </span>
                {p && p.d > 0 && (
                  <div className="bar poster-bar">
                    <i style={{ width: `${(p.t / p.d) * 100}%` }} />
                  </div>
                )}
              </div>
              <div className="ep-text">
                <div className="ep-title">
                  <span className="muted">É{ep.episode}</span> {ep.title}
                </div>
                {ep.duration && <div className="muted small">{ep.duration}</div>}
                {ep.plot && <div className="ep-plot">{ep.plot}</div>}
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
