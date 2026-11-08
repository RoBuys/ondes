export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Nom de chaîne normalisé pour rapprocher playlist et guide (« FR: TF1 HD » → « tf1 »). */
export function normName(n: string): string {
  return fold(n)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/^\s*[a-z]{2,3}\s*[:|]\s*/, '')
    .replace(/\b(fhd|uhd|hd|sd|4k|hevc|h265|h264)\b/g, '')
    .replace(/[^a-z0-9+]/g, '');
}

/** Renvoie un prédicat de recherche insensible à la casse et aux accents, ou null si la requête est vide. */
export function makeSearch(q: string): ((s: string) => boolean) | null {
  const f = fold(q.trim());
  return f ? (s: string) => fold(s).includes(f) : null;
}

export const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

export const fmtDate = (t: number) =>
  new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export const fmtCount = (n: number) => n.toLocaleString('fr-FR');

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function cx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(' ');
}
