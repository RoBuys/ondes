import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useApp } from '../context';
import { applyRules, loadRules } from '../lib/content';
import { db } from '../lib/store';
import type { Catalog, Channel, Movie, Show } from '../lib/types';
import { fmtCount, makeSearch } from '../lib/util';
import { Empty, Img } from './ui';

const LIMIT = 48;

interface Hit<T> {
  item: T;
  sourceId: string;
}

/** Searches the catalogs of every source (those loaded at least once). */
export function SearchView({ query, onDone }: { query: string; onDone: () => void }) {
  const { sources, rawCatalog, setActiveId, setLiveSel, setView, setPendingOpen } = useApp();
  const [cats, setCats] = useState<Record<string, Catalog>>({});
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const q = useDeferredValue(query);

  useEffect(() => {
    let off = false;
    Promise.all(sources.map(async (s) => [s.id, await db.catalog(s.id)] as const)).then((pairs) => {
      if (off) return;
      const out: Record<string, Catalog> = {};
      for (const [id, c] of pairs) if (c) out[id] = applyRules(c, loadRules(id));
      setCats(out);
      setLoaded(true);
    });
    return () => {
      off = true;
    };
  }, [sources, rawCatalog?.fetchedAt]);

  const res = useMemo(() => {
    const m = makeSearch(q);
    const live: Hit<Channel>[] = [];
    const movies: Hit<Movie>[] = [];
    const series: Hit<Show>[] = [];
    if (!m) return { live, movies, series };
    for (const s of sources) {
      if (s.hidden) continue;
      const c = cats[s.id];
      if (!c) continue;
      for (const item of c.live) if (m(item.name)) live.push({ item, sourceId: s.id });
      for (const item of c.movies) if (m(item.name)) movies.push({ item, sourceId: s.id });
      for (const item of c.series) if (m(item.name)) series.push({ item, sourceId: s.id });
    }
    return { live, movies, series };
  }, [q, cats, sources]);

  const name = (id: string) => sources.find((s) => s.id === id)?.name ?? '';
  const multi = sources.length > 1;
  const missing = sources.filter((s) => !cats[s.id]);
  const total = res.live.length + res.movies.length + res.series.length;

  const openChannel = (h: Hit<Channel>) => {
    setActiveId(h.sourceId);
    setLiveSel(h.item.id);
    setView('live');
    onDone();
  };
  const openVod = (kind: 'movie' | 'show', h: Hit<Movie | Show>) => {
    setActiveId(h.sourceId);
    setPendingOpen({ kind, id: h.item.id, sourceId: h.sourceId });
    setView(kind === 'movie' ? 'movies' : 'series');
    onDone();
  };

  const section = <T extends Channel | Movie | Show>(key: string, title: string, hits: Hit<T>[], render: (h: Hit<T>) => React.ReactNode, grid: boolean) => {
    if (!hits.length) return null;
    const shown = more[key] ? hits : hits.slice(0, LIMIT);
    return (
      <section className="search-section">
        <div className="section-head">
          <h3>
            {title} <span className="muted">({fmtCount(hits.length)})</span>
          </h3>
          {hits.length > LIMIT && (
            <button className="btn ghost" onClick={() => setMore((m) => ({ ...m, [key]: !m[key] }))}>
              {more[key] ? 'Réduire' : `Tout afficher`}
            </button>
          )}
        </div>
        <div className={grid ? 'poster-grid' : 'search-list'}>{shown.map(render)}</div>
      </section>
    );
  };

  if (!loaded) return <div className="center-msg"><span className="spinner" /></div>;

  return (
    <div className="search-page">
      <div className="muted small">
        {q ? `${fmtCount(total)} résultat${total > 1 ? 's' : ''} pour « ${q} »` : 'Tapez pour chercher'}
        {multi && ` dans ${sources.length - missing.length} source${sources.length - missing.length > 1 ? 's' : ''}`}
        {missing.length > 0 && ` · non chargées : ${missing.map((s) => s.name).join(', ')}`}
      </div>

      {q && total === 0 && <Empty title="Aucun résultat" icon="search">Essayez un autre mot ou une orthographe plus courte.</Empty>}

      {section(
        'live',
        'Chaînes',
        res.live,
        (h) => (
          <button key={h.sourceId + h.item.id} className="search-row" onClick={() => openChannel(h)}>
            <Img className="ch-logo" src={h.item.logo} alt={h.item.name} />
            <div className="ch-text">
              <div className="ch-name">{h.item.name}</div>
              <div className="muted small ellipsis">
                {h.item.group}
                {multi && ` · ${name(h.sourceId)}`}
              </div>
            </div>
          </button>
        ),
        false,
      )}

      {section(
        'movies',
        'Films',
        res.movies,
        (h) => (
          <button key={h.sourceId + h.item.id} className="poster" onClick={() => openVod('movie', h)}>
            <div className="poster-img">
              <Img src={h.item.poster} alt={h.item.name} />
            </div>
            <div className="poster-name">{h.item.name}</div>
            <div className="poster-year">{[h.item.year, multi && name(h.sourceId)].filter(Boolean).join(' · ')}</div>
          </button>
        ),
        true,
      )}

      {section(
        'series',
        'Séries',
        res.series,
        (h) => (
          <button key={h.sourceId + h.item.id} className="poster" onClick={() => openVod('show', h)}>
            <div className="poster-img">
              <Img src={h.item.poster} alt={h.item.name} />
            </div>
            <div className="poster-name">{h.item.name}</div>
            <div className="poster-year">{[h.item.year, multi && name(h.sourceId)].filter(Boolean).join(' · ')}</div>
          </button>
        ),
        true,
      )}
    </div>
  );
}
