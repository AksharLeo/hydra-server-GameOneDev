/**
 * Shared state: the theme, and the dashboard snapshot the shell reuses for
 * sidebar counts so every navigation doesn't re-query the server.
 */

import { api } from "/assets/shared/js/api.js";

const THEME_KEY = "hydra-admin-theme";

const listeners = new Set();

export const store = {
  overview: null,
  overviewAt: 0,
  settings: null,
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(store);
}

/** Cached for a few seconds: enough to serve a burst of views, short enough
 *  that a refresh after an action shows the new numbers. */
export async function overview({ force = false } = {}) {
  const fresh = Date.now() - store.overviewAt < 5000;
  if (store.overview && fresh && !force) return store.overview;

  store.overview = await api.get("/admin/api/overview");
  store.overviewAt = Date.now();
  emit();
  return store.overview;
}

export function invalidate() {
  store.overviewAt = 0;
}

export function theme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function toggleTheme() {
  const next = theme() === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (_) {
    /* private mode: the theme just won't persist */
  }
  emit();
  return next;
}
