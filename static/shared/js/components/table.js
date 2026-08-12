/**
 * The one table every listing screen uses.
 *
 * Columns declare how to render a cell; sorting and paging are handed back to
 * the caller so the server does both — the panel never sorts a page of 25 and
 * calls it a sort of 4000.
 */

import { h, icon } from "/assets/shared/js/dom.js";
import * as fmt from "/assets/shared/js/format.js";
import { emptyState } from "./ui.js";

/**
 * @param {object}   config
 * @param {Array}    config.columns  { key, label, render(row), align, sortable, width }
 * @param {Array}    config.rows
 * @param {string}   config.sort     active sort key
 * @param {string}   config.dir      "asc" | "desc"
 * @param {Function} config.onSort   (key, dir) => void
 * @param {object}   config.page     { page, perPage, total, pageCount }
 * @param {Function} config.onPage   (page) => void
 * @param {Function} config.onRow    (row) => void — makes rows clickable
 * @param {Function} config.expand   (row) => Node | null — inline detail row
 */
export function dataTable({
  columns,
  rows,
  sort,
  dir = "desc",
  onSort,
  page,
  onPage,
  onRow,
  expand,
  empty,
}) {
  if (!rows.length) {
    return h("div", {}, empty ?? emptyState("Nothing here yet", "No rows match this view."));
  }

  const head = h(
    "tr",
    {},
    ...columns.map((column) =>
      h(
        "th",
        {
          class: [column.align === "right" ? "num" : "", column.sortable && onSort ? "sortable" : ""]
            .filter(Boolean)
            .join(" "),
          style: column.width ? { width: column.width } : null,
          onclick:
            column.sortable && onSort
              ? () => onSort(column.key, sort === column.key && dir === "desc" ? "asc" : "desc")
              : null,
        },
        column.label,
        column.sortable && sort === column.key
          ? h("span", { class: "sort-arrow", text: dir === "asc" ? "↑" : "↓" })
          : null,
      ),
    ),
  );

  const body = h("tbody", {});
  for (const row of rows) {
    const tr = h(
      "tr",
      {
        class: onRow || expand ? "clickable" : "",
        onclick: onRow ? (event) => {
          /* Buttons and links inside a row own their own clicks. */
          if (event.target.closest("button, a")) return;
          onRow(row);
        } : null,
      },
      ...columns.map((column) =>
        h(
          "td",
          {
            class: [column.align === "right" ? "num" : "", column.class ?? ""]
              .filter(Boolean)
              .join(" "),
          },
          column.render(row),
        ),
      ),
    );

    body.append(tr);

    if (expand) {
      /* Expanded content is a sibling row, so it spans the full width and
         survives re-sorting without re-layout tricks. */
      const detail = h("tr", { class: "subrow", hidden: true }, h("td", { colspan: columns.length }));
      body.append(detail);
      tr.addEventListener("click", async (event) => {
        if (event.target.closest("button, a")) return;
        detail.hidden = !detail.hidden;
        if (!detail.hidden && !detail.dataset.loaded) {
          detail.dataset.loaded = "1";
          const content = await expand(row);
          if (content) detail.firstChild.append(content);
          else detail.remove();
        }
      });
    }
  }

  return h(
    "div",
    {},
    h("div", { class: "table-wrap" }, h("table", { class: "data" }, h("thead", {}, head), body)),
    page && onPage ? pagination(page, onPage) : null,
  );
}

function pagination({ page, perPage, total, pageCount }, onPage) {
  const first = (page - 1) * perPage + 1;
  const last = Math.min(total, page * perPage);

  return h(
    "div",
    { class: "pagination" },
    h("span", { text: `${fmt.number(first)}–${fmt.number(last)} of ${fmt.number(total)}` }),
    h("span", { class: "spacer", style: { flex: 1 } }),
    h(
      "button",
      {
        class: "btn small icon-only",
        "aria-label": "Previous page",
        disabled: page <= 1,
        onclick: () => onPage(page - 1),
      },
      icon("chevronLeft", 14),
    ),
    h("span", { class: "num", text: `${page} / ${Math.max(1, pageCount)}` }),
    h(
      "button",
      {
        class: "btn small icon-only",
        "aria-label": "Next page",
        disabled: page >= pageCount,
        onclick: () => onPage(page + 1),
      },
      icon("chevronRight", 14),
    ),
  );
}

/** Filter bar above a table: search box plus whatever controls a view adds. */
export function toolbar({ search, onSearch, placeholder = "Search…", children = [] }) {
  const input = h("input", {
    type: "search",
    value: search ?? "",
    placeholder,
    "aria-label": placeholder,
  });

  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    /* Debounced: every keystroke is a query against the whole table. */
    timer = setTimeout(() => onSearch(input.value.trim()), 250);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      clearTimeout(timer);
      onSearch(input.value.trim());
    }
  });

  return h(
    "div",
    { class: "card-head" },
    h("div", { class: "search" }, icon("search", 15), input),
    h("span", { class: "spacer" }),
    ...children,
  );
}

// ---------------------------------------------------------------- columns

/**
 * Which columns a screen shows, remembered per browser.
 *
 * A stored list is the operator's explicit choice and is taken literally;
 * nothing stored means the column's own `default` applies. Storing the
 * *visible* keys rather than the hidden ones is what lets a column ship
 * switched off and still be turned on — the two are indistinguishable if you
 * only record what was removed.
 */
const COLUMN_STORE = "hydra.columns.";

function storedColumns(id) {
  try {
    const raw = localStorage.getItem(COLUMN_STORE + id);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The columns to render, in the order the caller declared them. */
export function chooseColumns(id, columns) {
  const stored = storedColumns(id);
  return columns.filter((column) =>
    column.fixed || (stored ? stored.includes(column.key) : column.default !== false),
  );
}

const columnTitle = (column) => column.title ?? column.label ?? column.key;

/**
 * The control that changes the above: a checklist of every column the screen
 * knows how to draw.
 */
export function columnMenu({ id, columns, onChange }) {
  const visible = new Set(chooseColumns(id, columns).map((column) => column.key));

  const save = () => {
    localStorage.setItem(COLUMN_STORE + id, JSON.stringify([...visible]));
    onChange();
  };

  const panel = h(
    "div",
    { class: "menu", hidden: true, role: "group", "aria-label": "Columns" },
    ...columns.map((column) =>
      h(
        "label",
        { class: "menu-item" },
        h("input", {
          type: "checkbox",
          checked: column.fixed || visible.has(column.key),
          /* A screen has to keep something to identify a row by, so its
             anchor columns are shown as chosen and can't be unchosen. */
          disabled: Boolean(column.fixed),
          onchange: (event) => {
            if (event.target.checked) visible.add(column.key);
            else visible.delete(column.key);
            save();
          },
        }),
        h("span", { text: columnTitle(column) }),
        column.fixed ? h("span", { class: "muted small", text: "always" }) : null,
      ),
    ),
    h("div", { class: "menu-sep" }),
    h("button", {
      class: "btn small ghost",
      text: "Reset to defaults",
      onclick: () => {
        localStorage.removeItem(COLUMN_STORE + id);
        onChange();
      },
    }),
  );

  const button = h(
    "button",
    {
      class: "btn small",
      "aria-haspopup": "true",
      "aria-expanded": "false",
      onclick: (event) => {
        event.stopPropagation();
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
      },
    },
    icon("columns", 14),
    "Columns",
  );

  /* Bound to the document rather than the panel: a menu that only closes via
     its own button is a menu left open behind whatever you clicked next. */
  const dismiss = (event) => {
    if (panel.hidden || anchor.contains(event.target)) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  addEventListener("click", dismiss);
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismiss(event);
  });

  const anchor = h("div", { class: "menu-anchor" }, button, panel);
  return anchor;
}

/** Segmented control for the small, mutually exclusive filters. */
export function segmented({ options, value, onChange }) {
  return h(
    "div",
    { class: "segmented" },
    ...options.map((option) =>
      h("button", {
        "aria-pressed": String((option.value ?? "") === (value ?? "")),
        text: option.label,
        onclick: () => onChange(option.value),
      }),
    ),
  );
}
