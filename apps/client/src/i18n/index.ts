import en from './en.json';

/**
 * Minimal i18n layer.
 *
 * Every user-visible string in the client comes from `en.json` (design rule:
 * English first, but no string literals scattered through scenes). Adding a
 * language later means adding a `<lang>.json` and registering it here.
 */

export type TranslationKey = keyof typeof en;
export type TranslationParams = Record<string, string | number>;

const dictionaries: Record<string, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
};

let activeLocale = 'en';

export function setLocale(locale: string): void {
  if (!dictionaries[locale]) {
    throw new Error(`Emberhold i18n: no dictionary for locale "${locale}"`);
  }
  activeLocale = locale;
}

export function getLocale(): string {
  return activeLocale;
}

/** Translate a key, substituting `{name}` placeholders from `params`. */
export function t(key: TranslationKey, params?: TranslationParams): string {
  const template = dictionaries[activeLocale]?.[key];
  if (template === undefined) {
    // Loud in development, never silent: a missing key is a bug.
    if (import.meta.env.DEV) {
      console.warn(`Emberhold i18n: missing key "${key}" for locale "${activeLocale}"`);
    }
    return key;
  }
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
