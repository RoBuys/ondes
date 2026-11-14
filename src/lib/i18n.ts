import { EN } from './i18n-en';
import { prefs } from './store';

/**
 * Interface language. French strings are the source of truth and double as translation keys:
 * `t('Réessayer')` returns "Réessayer" in French and "Retry" in English. A missing English entry falls back
 * to French instead of showing a blank.
 */
export type Lang = 'fr' | 'en';

export const LANG_NAMES: Record<Lang, string> = { fr: 'Français', en: 'English' };

function detect(): Lang {
  const saved = prefs.get<Lang | null>('lang', null);
  if (saved === 'fr' || saved === 'en') return saved;
  // First launch: follow the system language.
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export const lang: Lang = detect();

/** Locale for dates, times and numbers (24-hour clock in both languages). */
export const locale = lang === 'fr' ? 'fr-FR' : 'en-GB';

/** Saves the language and reloads the interface in it. */
export function setLang(l: Lang) {
  prefs.set('lang', l);
  location.reload();
}

/** Translates a French UI string; `{name}` placeholders are filled from `vars`. */
export function t(fr: string, vars?: Record<string, string | number>): string {
  let s = lang === 'en' ? (EN[fr] ?? fr) : fr;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** Singular or plural form for `n` (French treats 0 as singular, English as plural). */
export function plural(n: number, one: string, many: string) {
  return (lang === 'fr' ? n <= 1 : n === 1) ? one : many;
}

/**
 * Translates an error message coming from the Rust side (written in French): exact messages, then
 * "<prefix> : <detail>" and "Le serveur a répondu <status>" forms, keeping the technical detail as is.
 */
export function tErr(msg: string): string {
  if (lang === 'fr') return msg;
  if (EN[msg]) return EN[msg];
  const status = /^Le serveur a répondu (.+)$/.exec(msg);
  if (status) return t('Le serveur a répondu {status}', { status: status[1] });
  const i = msg.indexOf(' : ');
  if (i > 0 && EN[msg.slice(0, i)]) return `${EN[msg.slice(0, i)]}: ${msg.slice(i + 3)}`;
  return msg;
}
