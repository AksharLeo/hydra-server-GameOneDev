/**
 * ⌘K command palette: jump to a screen, find a user or a game, run a
 * maintenance action — without learning where any of them live.
 *
 * Results come from the same endpoints the screens use, so anything the panel
 * can show, the palette can find.
 */

import { h, icon } from "../dom.js";
import * as fmt from "../format.js";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { NAV } from "./shell.js";

const STATIC_COMMANDS = [
  ...NAV.flatMap((group) =>
    group.items.map((item) => ({
      group: "Go to",
      label: item.label,
      icon: item.icon,
      run: () => navigate(item.route),
    })),
  ),
  {
    group: "Filters",
    label: "Cloud saves that never finished uploading",
    icon: "warning",
    run: () => navigate("/saves?type=cloud&state=pending"),
  },
  {
    group: "Filters",
    label: "Largest saves on the server",
    icon: "saves",
    run: () => navigate("/saves?sort=size&dir=desc"),
  },
  {
    group: "Filters",
    label: "Blocked users",
    icon: "block",
    run: () => navigate("/users?status=blocked"),
  },
];

let open = false;

export function openPalette() {
  if (open) return;
  open = true;

  const input = h("input", {
    type: "text",
    placeholder: "Search users, games, or jump to a screen…",
    "aria-label": "Command palette",
  });
  const results = h("div", { class: "palette-results" });
  const panel = h(
    "div",
    { class: "palette", role: "dialog", "aria-modal": "true" },
    h("div", { class: "palette-input" }, icon("search", 16), input, h("span", { class: "kbd", text: "esc" })),
    results,
  );
  const scrim = h("div", { class: "scrim" }, panel);

  let items = [];
  let active = 0;
  let token = 0;

  const close = () => {
    open = false;
    scrim.remove();
    removeEventListener("keydown", onKey);
  };

  const paint = () => {
    results.replaceChildren();
    if (!items.length) {
      results.append(h("div", { class: "palette-group", text: "No matches" }));
      return;
    }

    let group = null;
    items.forEach((item, index) => {
      if (item.group !== group) {
        group = item.group;
        results.append(h("div", { class: "palette-group", text: group }));
      }
      results.append(
        h(
          "div",
          {
            class: "palette-item",
            dataset: { active: String(index === active) },
            onclick: () => {
              close();
              item.run();
            },
            onmousemove: () => {
              if (active === index) return;
              active = index;
              paint();
            },
          },
          icon(item.icon ?? "dot", 15),
          h("span", { class: "truncate", text: item.label }),
          item.sub ? h("span", { class: "sub", text: item.sub }) : null,
        ),
      );
    });

    results.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  };

  const search = async (query) => {
    const current = ++token;
    const trimmed = query.trim();

    const matches = STATIC_COMMANDS.filter((command) =>
      command.label.toLowerCase().includes(trimmed.toLowerCase()),
    );

    if (trimmed.length < 2) {
      items = matches;
      active = 0;
      paint();
      return;
    }

    const [users, games] = await Promise.all([
      api.get("/admin/api/users", { q: trimmed, perPage: 5 }).catch(() => ({ rows: [] })),
      api.get("/admin/api/games", { q: trimmed, perPage: 5 }).catch(() => ({ rows: [] })),
    ]);

    /* A slower earlier query must never overwrite a newer one's results. */
    if (current !== token) return;

    items = [
      ...matches,
      ...users.rows.map((user) => ({
        group: "Users",
        label: user.displayName || user.id,
        sub: fmt.bytes(user.usedBytes),
        icon: "user",
        run: () => navigate(`/users/${encodeURIComponent(user.id)}`),
      })),
      ...games.rows.map((entry) => ({
        group: "Games",
        label: fmt.gameName(entry.game),
        sub: fmt.bytes(entry.bytes),
        icon: "games",
        run: () =>
          navigate(
            `/games/${encodeURIComponent(entry.game.shop)}/${encodeURIComponent(entry.game.objectId)}`,
          ),
      })),
    ];
    active = 0;
    paint();
  };

  const onKey = (event) => {
    if (event.key === "Escape") {
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(items.length - 1, active + 1);
      paint();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, active - 1);
      paint();
    } else if (event.key === "Enter" && items[active]) {
      event.preventDefault();
      close();
      items[active].run();
    }
  };

  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value), 160);
  });

  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) close();
  });
  addEventListener("keydown", onKey);
  document.body.append(scrim);
  input.focus();
  search("");
}
