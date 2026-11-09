import { useMemo, useState } from 'react';
import { useApp } from '../context';
import type { Movie, Show } from '../lib/types';
import { fmtTime } from '../lib/util';
import { nowAndNext, programmesFor, progressOf } from '../lib/xmltv';
import { Empty, Icon, Img, useNow } from './ui';
import { MovieDetail, PosterCard, ShowDetail } from './Vod';

/** "Favorites" tab: starred channels, movies and series of the active source. */
export function FavoritesView() {
  const { catalog, favs, toggleFav, epg, setLiveSel, setView } = useApp();
  const [movie, setMovie] = useState<Movie | null>(null);
  const [show, setShow] = useState<Show | null>(null);
  const now = useNow(30000);

  const fav = useMemo(() => {
    if (!catalog) return { live: [], movies: [], series: [] };
    return {
      live: catalog.live.filter((c) => favs.has(c.id)),
      movies: catalog.movies.filter((m) => favs.has(m.id)),
      series: catalog.series.filter((s) => favs.has(s.id)),
    };
  }, [catalog, favs]);

  if (!catalog) return null;
  if (!fav.live.length && !fav.movies.length && !fav.series.length) {
    return (
      <Empty title="Aucun favori" icon="star">
        Cliquez sur l’étoile d’une chaîne, d’un film ou d’une série pour la retrouver ici.
      </Empty>
    );
  }

  return (
    <div className="favorites">
      {fav.live.length > 0 && (
        <section>
          <h3>
            Chaînes <span className="muted">({fav.live.length})</span>
          </h3>
          <div className="fav-channels">
            {fav.live.map((ch) => {
              const cur = nowAndNext(programmesFor(epg, ch), now).cur;
              return (
                <div
                  key={ch.id}
                  className="fav-channel"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setLiveSel(ch.id);
                    setView('live');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setLiveSel(ch.id);
                      setView('live');
                    }
                  }}
                >
                  <Img className="ch-logo" src={ch.logo} alt={ch.name} />
                  <div className="ch-text">
                    <div className="ch-name">{ch.name}</div>
                    {cur ? (
                      <div className="ch-prog">
                        <span>
                          {fmtTime(cur.start)} · {cur.title}
                        </span>
                        <div className="bar">
                          <i style={{ width: `${progressOf(cur, now) * 100}%` }} />
                        </div>
                      </div>
                    ) : (
                      <div className="ch-prog muted">{ch.group}</div>
                    )}
                  </div>
                  <button
                    className="fav on"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFav(ch.id);
                    }}
                    aria-label="Retirer des favoris"
                  >
                    <Icon name="star" size={17} filled />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {fav.movies.length > 0 && (
        <section>
          <h3>
            Films <span className="muted">({fav.movies.length})</span>
          </h3>
          <div className="poster-grid">
            {fav.movies.map((m) => (
              <PosterCard key={m.id} item={m} label="Film" onOpen={() => setMovie(m)} />
            ))}
          </div>
        </section>
      )}

      {fav.series.length > 0 && (
        <section>
          <h3>
            Séries <span className="muted">({fav.series.length})</span>
          </h3>
          <div className="poster-grid">
            {fav.series.map((s) => (
              <PosterCard key={s.id} item={s} label="Série" onOpen={() => setShow(s)} />
            ))}
          </div>
        </section>
      )}

      {movie && <MovieDetail movie={movie} onClose={() => setMovie(null)} />}
      {show && <ShowDetail show={show} onClose={() => setShow(null)} />}
    </div>
  );
}
