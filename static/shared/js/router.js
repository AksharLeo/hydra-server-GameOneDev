/**
 * Hash routing.
 *
 * The panel lives at one URL the server already serves, so every screen is a
 * fragment — no history API, no server-side rewrite rules, and a pasted link
 * like `#/saves?type=cloud&state=pending` still lands where it should.
 */

const routes = [];
let onChange = () => {};

/** register("/users/:id", view) — `:name` segments become params. */
export function register(pattern, view) {
  const keys = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      keys.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");

  routes.push({ pattern: new RegExp(`^${source}$`), keys, view });
}

export function current() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, search = ""] = raw.split("?");
  const query = Object.fromEntries(new URLSearchParams(search));

  for (const route of routes) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const params = Object.fromEntries(
      route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
    );
    return { path, query, params, view: route.view };
  }

  return { path, query, params: {}, view: null };
}

export function navigate(to, { replace = false } = {}) {
  const target = to.startsWith("#") ? to : `#${to}`;
  if (location.hash === target) {
    onChange();
    return;
  }
  if (replace) location.replace(target);
  else location.hash = target;
}

/** Rewrites the query string of the current route without adding history. */
export function setQuery(patch) {
  const { path, query } = current();
  const next = { ...query, ...patch };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null || value === "") delete next[key];
  }
  const search = new URLSearchParams(next).toString();
  navigate(search ? `${path}?${search}` : path, { replace: true });
}

export function start(handler) {
  onChange = handler;
  addEventListener("hashchange", handler);
  handler();
}
