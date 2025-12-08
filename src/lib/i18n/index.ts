import { register, init, getLocaleFromNavigator, locale, waitLocale } from 'svelte-i18n';

register('en', () => import('./en.json'));
register('zh', () => import('./zh.json'));

// Initialize immediately
const savedLocale = typeof window !== 'undefined' ? localStorage.getItem('locale') : null;

init({
  fallbackLocale: 'en',
  initialLocale: savedLocale || (typeof window !== 'undefined' ? getLocaleFromNavigator() : null) || 'en',
});

export { waitLocale };

export function setLocale(newLocale: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('locale', newLocale);
  }
  locale.set(newLocale);
}
