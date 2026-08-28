type UiLocale = 'zh-CN' | 'en';

declare global {
  interface Window {
    __CODEX_ANYWHERE_CONFIG__?: { locale?: string };
  }
}

function normalizeLocale(value?: string): UiLocale {
  return String(value || '').trim().toLocaleLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}

const runtimeLocale = typeof window === 'undefined' ? undefined : window.__CODEX_ANYWHERE_CONFIG__?.locale;

const uiLocale = normalizeLocale(runtimeLocale);
export const dateLocale = uiLocale === 'en' ? 'en-US' : 'zh-CN';

if (typeof document !== 'undefined') document.documentElement.lang = uiLocale;

export function t(chinese: string, english: string) {
  return uiLocale === 'en' ? english : chinese;
}
