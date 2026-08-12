/**
 * The player's own view of what this server holds for them.
 *
 * Same components and design system as the admin panel, a fraction of the
 * surface: sign in, see your storage, download or delete your own saves.
 */

import { api, events } from "/assets/shared/js/api.js";
import { register, current, start, navigate } from "/assets/shared/js/router.js";
import { h, icon } from "/assets/shared/js/dom.js";
import * as fmt from "/assets/shared/js/format.js";
import { avatar, toast, skeleton } from "/assets/shared/js/components/ui.js";

import login from "/assets/portal/js/views/login.js";
import home from "/assets/portal/js/views/home.js";
import saves from "/assets/portal/js/views/saves.js";
import library from "/assets/portal/js/views/library.js";

register("/", home);
register("/saves", saves);
register("/library", library);

const THEME_KEY = "hydra-portal-theme";
const NAV = [
  { route: "/", label: "Overview", icon: "overview" },
  { route: "/saves", label: "My saves", icon: "saves" },
  { route: "/library", label: "Achievements & more", icon: "trophy" },
];

const app = document.getElementById("app");
let content = null;
let renderToken = 0;
let signedIn = false;

async function boot() {
  try {
    const session = await api.get("/portal/api/session");
    showApp(session);
  } catch (error) {
    if (error.status === 403) {
      app.replaceChildren(
        h("div", { class: "login-page" },
          h("div", { class: "login-card" },
            h("h1", { text: "Portal unavailable" }),
            h("p", { class: "muted small", text: error.message }))),
      );
      return;
    }
    showLogin();
  } finally {
    app.removeAttribute("aria-busy");
  }
}

function showLogin() {
  signedIn = false;
  app.replaceChildren(login.render({ onSuccess: boot }));
}

function showApp(session) {
  signedIn = true;
  const user = session.user;

  const nav = h(
    "nav",
    { class: "tabs", style: { border: "none" } },
    ...NAV.map((item) =>
      h(
        "a",
        { class: "nav-item", href: `#${item.route}`, dataset: { route: item.route } },
        icon(item.icon, 15),
        h("span", { text: item.label }),
      ),
    ),
  );

  content = h("main", { class: "content" });

  app.replaceChildren(
    h(
      "div",
      { class: "portal-shell" },
      h(
        "header",
        { class: "topbar" },
        h("div", { class: "brand-mark", text: "H" }),
        h(
          "div",
          { class: "stack" },
          h("h1", { text: "My Hydra saves" }),
          h("span", { class: "subtitle", text: session.server.publicUrl }),
        ),
        h("span", { class: "spacer" }),
        h(
          "div",
          { class: "identity" },
          avatar(user),
          h("span", { class: "name truncate", text: user.displayName || user.id }),
        ),
        h(
          "button",
          {
            class: "btn ghost icon-only",
            "aria-label": "Toggle theme",
            onclick: (event) => {
              const next =
                document.documentElement.dataset.theme === "light" ? "dark" : "light";
              document.documentElement.dataset.theme = next;
              try {
                localStorage.setItem(THEME_KEY, next);
              } catch (_) {}
              event.currentTarget.replaceChildren(icon(next === "light" ? "moon" : "sun"));
            },
          },
          icon(document.documentElement.dataset.theme === "light" ? "moon" : "sun"),
        ),
        h(
          "button",
          {
            class: "btn ghost icon-only",
            "aria-label": "Sign out",
            onclick: async () => {
              await api.post("/portal/api/logout").catch(() => {});
              location.reload();
            },
          },
          icon("logout"),
        ),
      ),
      h("div", { class: "portal-nav" }, nav),
      content,
    ),
  );

  start(async () => {
    const route = current();
    if (!route.view) {
      navigate("/", { replace: true });
      return;
    }

    for (const link of nav.children) {
      const active = link.dataset.route === route.path;
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }

    const token = ++renderToken;
    content.replaceChildren(h("section", { class: "card" }, skeleton(4)));

    try {
      const node = await route.view.render({ ...route });
      if (token === renderToken) content.replaceChildren(node);
    } catch (error) {
      if (token !== renderToken || error.status === 401) return;
      content.replaceChildren(
        h("section", { class: "card" },
          h("div", { class: "empty" },
            h("div", { class: "title", text: "Couldn't load this" }),
            h("div", { class: "small muted", text: error.message }))),
      );
    }
  });
}

events.addEventListener("unauthorized", () => {
  if (!signedIn) return;
  toast("Session expired — sign in again", "critical");
  showLogin();
});

export { fmt };

boot();
