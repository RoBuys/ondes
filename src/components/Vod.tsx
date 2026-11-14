import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context';
import { downloadsAvailable, localSrc } from '../lib/downloads';
import { mediaSrc } from '../lib/net';
import { getPosition, getPositions } from '../lib/store';
import type { Episode, Movie, Show } from '../lib/types';
import { cx, errMsg, fmtCount, makeSearch } from '../lib/util';
import { xtSeriesInfo, xtVodInfo, type ExtraInfo } from '../lib/xtream';
import { DownloadButton } from './Downloads';
import { Empty, GroupList, Icon, Img, Modal, SearchBox, copyText, type GroupItem } from './ui';
import { plural, t } from '../lib/i18n';

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
      if (n) out.push({ id: CONT, label: t("Continuer"), count: n, icon: 'play' });
    }
    out.push(
      { id: FAV, label: t("Favoris"), count: items.reduce((k, m) => k + (favs.has(m.id) ? 1 : 0), 0), icon: 'star' },
      { id: ALL, label: t("Tout"), count: items.length, icon: 'film' },
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
  const { favs, organize } = useApp();
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
      <Empty title={kind === 'movies' ? t("Aucun film") : t("Aucune série")} icon={kind === 'movies' ? 'film' : 'series'}>
        {kind === 'movies' ? t('Cette source ne propose pas de films.') : t('Cette source ne propose pas de séries.')}
      </Empty>
    );
  }

  return (
    <div className="vod">
      <GroupList
        groups={groups}
        value={q ? '' : group}
        onChange={(g) => (setGroup(g), setQ(''))}
        onManage={() => organize(kind === 'movies' ? 'm' : 's')}
      />
      <div className="vod-main">
        <div className="pane-head">
          <SearchBox value={q} onChange={setQ} placeholder={kind === 'movies' ? t("Rechercher un film") : t("Rechercher une série")} />
          <span className="muted small">{t(plural(list.length, '{n} titre', '{n} titres'), { n: fmtCount(list.length) })}</span>
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
            <div className="pane-empty">{q ? t("Aucun résultat.") : t("Rien ici pour l’instant.")}</div>
          ) : (
            <div className="poster-grid">
              {list.slice(0, limit).map((m) => (
                <PosterCard key={m.id} item={m} label={kind === 'movies' ? t("Film") : t("Série")} onOpen={() => onOpen(m)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PosterCard({ item, onOpen, label }: { item: Item; onOpen: () => void; label: string }) {
  const { favs, editItem, toggleFav } = useApp();
  const pos = getPosition(item.id);
  const fav = favs.has(item.id);
  return (
    <button
      className="poster"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        editItem(item.id, `${label} · ${item.group}`);
      }}
    >
      <div className="poster-img">
        <Img src={item.poster} alt={item.name} />
        <span
          className={cx('poster-fav', fav && 'on')}
          role="button"
          title={fav ? t("Retirer des favoris") : t("Ajouter aux favoris")}
          onClick={(e) => {
            e.stopPropagation();
            toggleFav(item.id);
          }}
        >
          <Icon name="star" size={15} filled={fav} />
        </span>
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

/* ---------------- Movies ---------------- */

export function MoviesView() {
  const { catalog, pendingOpen, setPendingOpen } = useApp();
  const [open, setOpen] = useState<Movie | null>(null);
  useEffect(() => {
    if (!catalog || pendingOpen?.kind !== 'movie' || catalog.sourceId !== pendingOpen.sourceId) return;
    const m = catalog.movies.find((x) => x.id === pendingOpen.id);
    if (m) setOpen(m);
    setPendingOpen(null);
  }, [catalog, pendingOpen, setPendingOpen]);
  const contIds = useMemo(() => new Set(Object.keys(getPositions())), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!catalog) return null;
  return (
    <>
      <Browser items={catalog.movies} kind="movies" contIds={contIds} onOpen={setOpen} />
      {open && <MovieDetail movie={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function MovieDetail({ movie, onClose }: { movie: Movie; onClose: () => void }) {
  const { active, play, favs, toggleFav, overlay, downloads } = useApp();
  const [info, setInfo] = useState<ExtraInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const local = downloads.items[movie.id] ? localSrc(downloads.items[movie.id]) : undefined;

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
    play({
      key: movie.id,
      title: movie.name,
      subtitle: local ? [movie.year, t('fichier téléchargé')].filter(Boolean).join(' · ') : movie.year,
      urls: local ? [local, movie.url] : [movie.url],
      live: false,
      resumeKey: movie.id,
      poster: info?.backdrop,
    });

  const meta = [movie.year, info?.genre, info?.duration, (info?.rating || movie.rating) && `★ ${info?.rating || movie.rating}`].filter(Boolean);

  return (
    <Modal onClose={onClose} className="detail">
      {info?.backdrop && <div className="detail-backdrop" style={{ backgroundImage: `url("${mediaSrc(info.backdrop)}")` }} />}
      <div className="detail-body">
        <Img className="detail-poster" src={movie.poster} alt={movie.name} />
        <div className="detail-text">
          <div className="muted small">{movie.group}</div>
          <h2>{movie.name}</h2>
          {meta.length > 0 && <div className="detail-meta">{meta.join(' · ')}</div>}
          <div className="row">
            <button className="btn" onClick={start}>
              <Icon name="play" size={16} filled /> {pos ? t("Reprendre") : t("Lecture")}
            </button>
            <button className={cx('btn ghost', favs.has(movie.id) && 'active')} onClick={() => toggleFav(movie.id)}>
              <Icon name="star" size={16} filled={favs.has(movie.id)} /> {favs.has(movie.id) ? t("Favori") : t("Favoris")}
            </button>
            <DownloadButton
              id={movie.id}
              onStart={() =>
                active &&
                downloads.add({
                  id: movie.id,
                  sourceId: active.id,
                  kind: 'movie',
                  title: movie.name,
                  subtitle: [movie.year, info?.genre].filter(Boolean).join(' · ') || undefined,
                  poster: movie.poster,
                  url: movie.url,
                  baseName: movie.name,
                })
              }
            />
            <button
              className="btn ghost"
              onClick={async () => {
                if (await copyText(movie.url)) setCopied(true);
              }}
              title={t("Pour l’ouvrir dans un autre lecteur (VLC…)")}
            >
              <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? t("Copiée") : t("Copier le lien")}
            </button>
          </div>
          {pos && pos.d > 0 && (
            <div className="resume">
              <div className="bar">
                <i style={{ width: `${(pos.t / pos.d) * 100}%` }} />
              </div>
              <span className="muted small">{t('Arrêté à {t} min sur {d}', { t: Math.floor(pos.t / 60), d: Math.round(pos.d / 60) })}</span>
            </div>
          )}
          {info?.plot && <p className="detail-plot">{info.plot}</p>}
          {info?.director && (
            <p className="small">
              <span className="muted">{t("Réalisation :")} </span>
              {info.director}
            </p>
          )}
          {info?.cast && (
            <p className="small">
              <span className="muted">Avec : </span>
              {info.cast}
            </p>
          )}
          {err && <p className="muted small">{t('Détails indisponibles ({err}).', { err })}</p>}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Series ---------------- */

export function SeriesView() {
  const { catalog, pendingOpen, setPendingOpen } = useApp();
  const [open, setOpen] = useState<Show | null>(null);
  useEffect(() => {
    if (!catalog || pendingOpen?.kind !== 'show' || catalog.sourceId !== pendingOpen.sourceId) return;
    const s = catalog.series.find((x) => x.id === pendingOpen.id);
    if (s) setOpen(s);
    setPendingOpen(null);
  }, [catalog, pendingOpen, setPendingOpen]);
  if (!catalog) return null;
  return (
    <>
      <Browser items={catalog.series} kind="series" contIds={null} onOpen={setOpen} />
      {open && <ShowDetail show={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function ShowDetail({ show, onClose }: { show: Show; onClose: () => void }) {
  const { active, play, favs, toggleFav, overlay, downloads } = useApp();
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
    const dl = downloads.items[ep.id];
    const local = dl ? localSrc(dl) : undefined;
    play({
      key: ep.id,
      title: show.name,
      subtitle: `S${ep.season} · É${ep.episode} — ${ep.title}`,
      urls: local ? [local, ep.url] : [ep.url],
      live: false,
      resumeKey: ep.id,
      poster: ep.image || info?.backdrop,
      onEnded: next ? () => playEp(next) : undefined,
    });
  };

  const downloadEp = (ep: Episode) => {
    if (!active) return;
    const code = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
    const sameAsShow = ep.title.toLowerCase().startsWith(show.name.toLowerCase());
    downloads.add({
      id: ep.id,
      sourceId: active.id,
      kind: 'episode',
      title: show.name,
      subtitle: `S${ep.season} · É${ep.episode} — ${ep.title}`,
      poster: ep.image || show.poster,
      url: ep.url,
      baseName: sameAsShow ? ep.title : `${show.name} - ${code} - ${ep.title}`,
    });
  };

  const plot = info?.plot || show.plot;
  const meta = [show.year, info?.genre, (info?.rating || show.rating) && `★ ${info?.rating || show.rating}`].filter(Boolean);

  return (
    <Modal onClose={onClose} className="detail">
      {info?.backdrop && <div className="detail-backdrop" style={{ backgroundImage: `url("${mediaSrc(info.backdrop)}")` }} />}
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
                {resumeEp ? t('Reprendre S{s} É{e}', { s: resumeEp.season, e: resumeEp.episode }) : t("Premier épisode")}
              </button>
            )}
            <button className={cx('btn ghost', favs.has(show.id) && 'active')} onClick={() => toggleFav(show.id)}>
              <Icon name="star" size={16} filled={favs.has(show.id)} /> {favs.has(show.id) ? t("Favori") : t("Favoris")}
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
        {err && <div className="pane-empty">{t('Impossible de charger les épisodes : {err}', { err })}</div>}
        {!episodes && !err && (
          <div className="pane-empty">
            <span className="spinner" /> {t("Chargement des épisodes…")}
          </div>
        )}
        {episodes && episodes.length === 0 && <div className="pane-empty">{t("Aucun épisode disponible.")}</div>}
        {list.length > 0 && (
          <div className="season-bar">
            {seasons.length > 1 ? null : <span className="muted small">{t(plural(list.length, '{n} épisode', '{n} épisodes'), { n: list.length })}</span>}
            <DownloadSeason episodes={list} season={current} onDownload={downloadEp} />
          </div>
        )}
        {seasons.length > 1 && (
          <div className="seasons">
            {seasons.map((s) => (
              <button key={s} className={cx('chip', s === current && 'on')} onClick={() => setSeason(s)}>
                {t('Saison {n}', { n: s })}
              </button>
            ))}
          </div>
        )}
        {list.map((ep) => {
          const p = positions[ep.id];
          return (
            <div
              key={ep.id}
              className="ep"
              role="button"
              tabIndex={0}
              onClick={() => playEp(ep)}
              onKeyDown={(e) => e.key === 'Enter' && playEp(ep)}
            >
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
              <DownloadButton id={ep.id} compact onStart={() => downloadEp(ep)} />
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function DownloadSeason({ episodes, season, onDownload }: { episodes: Episode[]; season: number; onDownload: (e: Episode) => void }) {
  const { downloads } = useApp();
  if (!downloadsAvailable) return null;
  const todo = episodes.filter((e) => !downloads.items[e.id] || downloads.items[e.id].status === 'error');
  if (!todo.length) return <span className="muted small">{t('Saison {n} entièrement téléchargée ou en file d’attente', { n: season })}</span>;
  return (
    <button className="btn ghost" onClick={() => todo.forEach(onDownload)}>
      <Icon name="download" size={16} /> {t('Télécharger la saison {n} ({count})', { n: season, count: todo.length })}
    </button>
  );
}
