/* theme.js — light / dark switching.
 *
 * The initial theme is applied by an inline script in each page's <head>
 * (see the THEME_BOOT snippet) so there is never a flash of the wrong theme.
 * This module owns the toggle and the "follow config default" fallback.
 */

const KEY = 'gc4-theme';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

export function setTheme(theme, persist = true) {
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) {
    try { localStorage.setItem(KEY, theme); } catch { /* private mode */ }
  }
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  return currentTheme();
}

/** Called once config is available: honours the configured default if the
 *  operator has never expressed a preference on this machine. */
export function applyConfigDefault(config) {
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (!stored && config?.ui?.defaultTheme) {
    setTheme(config.ui.defaultTheme, false);
  }
}
