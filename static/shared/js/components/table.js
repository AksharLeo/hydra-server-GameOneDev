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
