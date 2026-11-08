import { useMemo, useState } from 'react';
import { useApp } from '../context';
import { emptyRules, rawGroups, type ContentRules, type Kind } from '../lib/content';
import { newList, toggleInList, type ChannelList } from '../lib/lists';
import { cx, makeSearch } from '../lib/util';
import { Icon, Modal } from './ui';

const KINDS: { id: Kind; label: string }[] = [
  { id: 'l', label: 'Chaînes' },
  { id: 'm', label: 'Films' },
  { id: 's', label: 'Séries' },
];

/** Fenêtre « Organiser » : groupes (visibilité, nom, ordre) et éléments masqués. */
export function OrganizeModal({ onClose, initialKind = 'l' }: { onClose: () => void; initialKind?: Kind | 'lists' }) {
  const { rawCatalog, rules, setRules, active } = useApp();
  const [tab, setTab] = useState<Kind | 'lists'>(initialKind);
  const kind: Kind = tab === 'lists' ? 'l' : tab;
  const [q, setQ] = useState('');
  const match = makeSearch(q);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const groups = useMemo(() => (rawCatalog ? rawGroups(rawCatalog, kind, rules) : []), [rawCatalog, kind, rules]);

  const hiddenItems = useMemo(() => {
    if (!rawCatalog) return [];
    const ids = new Set(rules.hiddenItems);
    const all = [
      ...rawCatalog.live.map((x) => ({ ...x, kind: 'Chaîne' })),
      ...rawCatalog.movies.map((x) => ({ ...x, kind: 'Film' })),
      ...rawCatalog.series.map((x) => ({ ...x, kind: 'Série' })),
    ];
    return all.filter((x) => ids.has(x.id));
  }, [rawCatalog, rules.hiddenItems]);

  if (!rawCatalog || !active) return null;

  const update = (fn: (r: ContentRules) => ContentRules) => setRules(fn(rules));

  /** Fixe l'ordre complet du type courant, en conservant celui des autres types. */
  const setOrder = (keys: string[]) =>
    update((r) => ({ ...r, groupOrder: [...r.groupOrder.filter((k) => !k.startsWith(`${kind}|`)), ...keys] }));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= groups.length || from === to) return;
    const keys = groups.map((g) => g.key);
    const [k] = keys.splice(from, 1);
    keys.splice(to, 0, k);
    setOrder(keys);
  };

  const toggleHidden = (key: string) =>
    update((r) => ({
      ...r,
      hiddenGroups: r.hiddenGroups.includes(key) ? r.hiddenGroups.filter((k) => k !== key) : [...r.hiddenGroups, key],
    }));

  const rename = (key: string, original: string, value: string) =>
    update((r) => {
      const groupNames = { ...r.groupNames };
      const v = value.trim();
      if (!v || v === original) delete groupNames[key];
      else groupNames[key] = v;
      return { ...r, groupNames };
    });

  /** Groupes concernés par les actions groupées : ceux qui correspondent au filtre, ou tous. */
  const shown = groups.filter((g) => !match || match(g.group) || match(rules.groupNames[g.key] ?? ''));

  const allVisible = (visible: boolean) =>
    update((r) => {
      const keys = new Set(shown.map((g) => g.key));
      const others = r.hiddenGroups.filter((k) => !keys.has(k));
      return { ...r, hiddenGroups: visible ? others : [...others, ...keys] };
    });

  /** N'afficher que les groupes filtrés (masque tous les autres groupes de ce type). */
  const onlyThese = () =>
    update((r) => {
      const keep = new Set(shown.map((g) => g.key));
      const others = r.hiddenGroups.filter((k) => !k.startsWith(`${kind}|`));
      return { ...r, hiddenGroups: [...others, ...groups.filter((g) => !keep.has(g.key)).map((g) => g.key)] };
    });

  const sortAlpha = () =>
    setOrder([...groups].sort((a, b) => a.group.localeCompare(b.group, 'fr', { sensitivity: 'base' })).map((g) => g.key));

  return (
    <Modal onClose={onClose} className="organize">
      <div>
        <h2>Organiser « {active.name} »</h2>
        <p className="muted small">
          Glissez les groupes pour les réordonner, décochez-les pour les masquer. Donner le même nom à deux groupes les fusionne.
          Clic droit sur une chaîne, un film ou une série pour la renommer ou la masquer.
        </p>
      </div>

      <div className="tabs">
        {KINDS.map((k) => (
          <button key={k.id} type="button" className={cx('tab', tab === k.id && 'on')} onClick={() => setTab(k.id)}>
            {k.label}
          </button>
        ))}
        <button type="button" className={cx('tab', tab === 'lists' && 'on')} onClick={() => setTab('lists')}>
          <Icon name="list" size={15} /> Mes listes
        </button>
      </div>

      {tab === 'lists' ? (
        <ListsManager />
      ) : (
      <>
      <div className="row">
        <label className="search org-filter">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer les groupes (ex. FR, Sport)" spellCheck={false} />
          {q && <span className="muted small">{shown.length}/{groups.length}</span>}
        </label>
      </div>
      <div className="row">
        <button className="btn ghost" onClick={() => allVisible(true)}>
          {q ? 'Afficher ces groupes' : 'Tout afficher'}
        </button>
        <button className="btn ghost" onClick={() => allVisible(false)}>
          {q ? 'Masquer ces groupes' : 'Tout masquer'}
        </button>
        {q && (
          <button className="btn ghost" onClick={onlyThese}>
            N’afficher que ceux-ci
          </button>
        )}
        <button className="btn ghost" onClick={sortAlpha}>
          Trier de A à Z
        </button>
        <button className="btn ghost" onClick={() => setOrder([])}>
          Ordre d’origine
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="pane-empty">Aucun groupe de ce type.</div>
      ) : (
        <div className="org-list">
          {groups.map((g, i) => {
            if (match && !match(g.group) && !match(rules.groupNames[g.key] ?? '')) return null;
            const hidden = rules.hiddenGroups.includes(g.key);
            return (
              <div
                key={g.key}
                className={cx('org-row', hidden && 'hidden', over === i && drag !== i && 'over')}
                draggable
                onDragStart={(e) => {
                  setDrag(i);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag != null) move(drag, i);
                  setDrag(null);
                  setOver(null);
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
              >
                <span className="org-grip" aria-hidden="true">
                  ⋮⋮
                </span>
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={() => toggleHidden(g.key)}
                  aria-label={hidden ? 'Afficher le groupe' : 'Masquer le groupe'}
                />
                <input
                  className="org-name"
                  defaultValue={rules.groupNames[g.key] ?? g.group}
                  placeholder={g.group}
                  onBlur={(e) => rename(g.key, g.group, e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  title={rules.groupNames[g.key] ? `Nom d’origine : ${g.group}` : undefined}
                />
                <span className="group-count">{g.count}</span>
                <button className="icon-btn sm" onClick={() => move(i, 0)} disabled={i === 0} title="Tout en haut">
                  <Icon name="top" size={16} />
                </button>
                <button className="icon-btn sm" onClick={() => move(i, i - 1)} disabled={i === 0} title="Monter">
                  <Icon name="up" size={16} />
                </button>
                <button className="icon-btn sm" onClick={() => move(i, i + 1)} disabled={i === groups.length - 1} title="Descendre">
                  <Icon name="down" size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      </>
      )}

      {hiddenItems.length > 0 && (
        <div className="org-hidden">
          <div className="section-label">Éléments masqués ({hiddenItems.length})</div>
          {hiddenItems.map((it) => (
            <div key={it.id} className="org-hidden-row">
              <span className="muted small">{it.kind}</span>
              <span className="ellipsis">{rules.itemNames[it.id] ?? it.name}</span>
              <button
                className="btn ghost"
                onClick={() => update((r) => ({ ...r, hiddenItems: r.hiddenItems.filter((x) => x !== it.id) }))}
              >
                Réafficher
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="row end">
        {confirmReset ? (
          <button
            className="btn danger"
            onClick={() => {
              setRules(emptyRules());
              setConfirmReset(false);
            }}
          >
            Confirmer la réinitialisation
          </button>
        ) : (
          <button className="btn ghost" onClick={() => setConfirmReset(true)}>
            Tout réinitialiser
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Terminé
        </button>
      </div>
    </Modal>
  );
}

export interface ItemTarget {
  id: string;
  name: string;
  /** Nom dans la playlist, avant personnalisation */
  original: string;
  label: string;
}

/** Fenêtre ouverte par clic droit : renommer ou masquer un élément. */
export function ItemModal({ target, onClose }: { target: ItemTarget; onClose: () => void }) {
  const { rules, setRules, favs, toggleFav } = useApp();
  const [name, setName] = useState(target.name);
  const isChannel = target.id.includes(':l:');

  const save = () => {
    const itemNames = { ...rules.itemNames };
    const v = name.trim();
    if (!v || v === target.original) delete itemNames[target.id];
    else itemNames[target.id] = v;
    setRules({ ...rules, itemNames });
    onClose();
  };

  return (
    <Modal onClose={onClose} className="item-modal">
      <div className="muted small">{target.label}</div>
      <h2>{target.name}</h2>
      <form
        className="add-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          <span>Nom affiché</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onFocus={(e) => e.target.select()}
            placeholder={target.original}
          />
        </label>
        {target.name !== target.original && <div className="muted small">Nom d’origine : {target.original}</div>}
        <div className="row">
          <button className="btn">Enregistrer</button>
          <button type="button" className="btn ghost" onClick={() => setName(target.original)}>
            Nom d’origine
          </button>
          <button type="button" className={cx('btn ghost', favs.has(target.id) && 'active')} onClick={() => toggleFav(target.id)}>
            <Icon name="star" size={16} filled={favs.has(target.id)} /> {favs.has(target.id) ? 'Favori' : 'Favoris'}
          </button>
          <div className="topbar-spacer" />
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setRules({ ...rules, hiddenItems: [...new Set([...rules.hiddenItems, target.id])] });
              onClose();
            }}
          >
            <Icon name="eyeoff" size={16} /> Masquer
          </button>
        </div>
      </form>
      {isChannel && <ListPicker channelId={target.id} />}
    </Modal>
  );
}


/** Cases à cocher « dans quelles listes » pour une chaîne, avec création d'une liste. */
export function ListPicker({ channelId }: { channelId: string }) {
  const { lists, setLists } = useApp();
  const [name, setName] = useState('');
  return (
    <div className="list-picker">
      <div className="section-label">Mes listes</div>
      {lists.length === 0 && <div className="muted small">Aucune liste pour l’instant : créez-en une ci-dessous.</div>}
      {lists.map((l) => (
        <label key={l.id} className="list-check">
          <input type="checkbox" checked={l.ids.includes(channelId)} onChange={() => setLists(toggleInList(lists, l.id, channelId))} />
          <span>{l.name}</span>
          <span className="group-count">{l.ids.length}</span>
        </label>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const l = newList(name);
          setLists([...lists, { ...l, ids: [channelId] }]);
          setName('');
        }}
      >
        <input className="list-new" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nouvelle liste (ex. Sport)" />
        <button className="btn ghost" disabled={!name.trim()}>
          <Icon name="plus" size={15} /> Créer et ajouter
        </button>
      </form>
    </div>
  );
}

/** Onglet « Mes listes » : renommer, supprimer, réordonner les listes et leurs chaînes. */
function ListsManager() {
  const { lists, setLists, rawCatalog, rules } = useApp();
  const [sel, setSel] = useState<string | null>(lists[0]?.id ?? null);
  const [name, setName] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const byId = useMemo(() => new Map((rawCatalog?.live ?? []).map((c) => [c.id, c])), [rawCatalog]);
  const cur = lists.find((l) => l.id === sel) ?? null;

  const patch = (id: string, fn: (l: ChannelList) => ChannelList) => setLists(lists.map((l) => (l.id === id ? fn(l) : l)));
  const moveList = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= lists.length) return;
    const next = [...lists];
    [next[i], next[j]] = [next[j], next[i]];
    setLists(next);
  };
  const moveItem = (i: number, d: number) =>
    cur &&
    patch(cur.id, (l) => {
      const j = i + d;
      if (j < 0 || j >= l.ids.length) return l;
      const ids = [...l.ids];
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return { ...l, ids };
    });

  return (
    <div className="lists-manager">
      <div className="lists-side">
        {lists.map((l, i) => (
          <div key={l.id} className={cx('lists-row', l.id === sel && 'on')} onClick={() => (setSel(l.id), setConfirmDel(false))}>
            <span className="ellipsis">{l.name}</span>
            <span className="group-count">{l.ids.length}</span>
            <button className="icon-btn sm" onClick={(e) => (e.stopPropagation(), moveList(i, -1))} disabled={i === 0} title="Monter">
              <Icon name="up" size={15} />
            </button>
            <button className="icon-btn sm" onClick={(e) => (e.stopPropagation(), moveList(i, 1))} disabled={i === lists.length - 1} title="Descendre">
              <Icon name="down" size={15} />
            </button>
          </div>
        ))}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const l = newList(name);
            setLists([...lists, l]);
            setSel(l.id);
            setName('');
          }}
        >
          <input className="list-new" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nouvelle liste" />
          <button className="icon-btn" disabled={!name.trim()} title="Créer">
            <Icon name="plus" size={18} />
          </button>
        </form>
      </div>

      <div className="lists-main">
        {!cur ? (
          <div className="pane-empty">Créez une liste, puis ajoutez-y des chaînes par clic droit ou avec le bouton « Listes » sous le lecteur.</div>
        ) : (
          <>
            <div className="row">
              <input
                key={cur.id}
                className="list-new"
                defaultValue={cur.name}
                onBlur={(e) => e.target.value.trim() && patch(cur.id, (l) => ({ ...l, name: e.target.value.trim() }))}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                aria-label="Nom de la liste"
              />
              {confirmDel ? (
                <button
                  className="btn danger"
                  onClick={() => {
                    setLists(lists.filter((l) => l.id !== cur.id));
                    setSel(lists.find((l) => l.id !== cur.id)?.id ?? null);
                    setConfirmDel(false);
                  }}
                >
                  Supprimer la liste
                </button>
              ) : (
                <button className="icon-btn" onClick={() => setConfirmDel(true)} title="Supprimer la liste">
                  <Icon name="trash" size={18} />
                </button>
              )}
            </div>
            {cur.ids.length === 0 ? (
              <div className="pane-empty">Liste vide : clic droit sur une chaîne → « Mes listes ».</div>
            ) : (
              <div className="org-list">
                {cur.ids.map((id, i) => {
                  const ch = byId.get(id);
                  return (
                    <div key={id} className="org-row">
                      <span className="ellipsis" style={{ flex: 1 }}>
                        {ch ? (rules.itemNames[id] ?? ch.name) : <span className="muted">Chaîne absente de la playlist</span>}
                      </span>
                      <span className="muted small ellipsis" style={{ maxWidth: 160 }}>
                        {ch?.group}
                      </span>
                      <button className="icon-btn sm" onClick={() => moveItem(i, -1)} disabled={i === 0} title="Monter">
                        <Icon name="up" size={16} />
                      </button>
                      <button className="icon-btn sm" onClick={() => moveItem(i, 1)} disabled={i === cur.ids.length - 1} title="Descendre">
                        <Icon name="down" size={16} />
                      </button>
                      <button
                        className="icon-btn sm"
                        onClick={() => patch(cur.id, (l) => ({ ...l, ids: l.ids.filter((x) => x !== id) }))}
                        title="Retirer de la liste"
                      >
                        <Icon name="x" size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
