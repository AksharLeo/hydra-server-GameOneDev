/** Your saves: look inside them, download them, delete the ones you don't want. */

import { h, icon } from "/assets/shared/js/dom.js";
import * as fmt from "/assets/shared/js/format.js";
import { api, download } from "/assets/shared/js/api.js";
import { setQuery } from "/assets/shared/js/router.js";
import {
  card,
  gameCell,
  pill,
  kindPill,
  stateLabel,
  emptyState,
  confirm,
  toast,
} from "/assets/shared/js/components/ui.js";
import { dataTable, segmented } from "/assets/shared/js/components/table.js";

export default {
  async render(ctx) {
    const rows = await api.get("/portal/api/saves", { type: ctx.query.type });

    const table = dataTable({
      columns: [
        { key: "kind", label: "Kind", render: (row) => kindPill(row.kind) },
        { key: "game", label: "Game", render: (row) => gameCell(row.game, { link: false }) },
        {
          key: "size",
          label: "Size",
          align: "right",
          render: (row) =>
            h(
              "div",
              { class: "stack", style: { justifyItems: "end" } },
              h("span", { class: "num", text: fmt.bytes(row.sizeBytes) }),
              row.fileCount
                ? h("span", { class: "muted small", text: fmt.plural(row.fileCount, "file") })
                : null,
            ),
        },
        {
          key: "state",
          label: "State",
          render: (row) =>
            h(
              "div",
              { class: "row", style: { gap: "6px" } },
              stateLabel(row.state),
              row.version ? pill(`v${row.version}`) : null,
              row.isFrozen ? pill("kept", "accent") : null,
            ),
        },
        {
          key: "host",
          label: "From",
          render: (row) =>
            h(
              "div",
              { class: "stack" },
              h("span", { class: "truncate", text: row.hostname || "—" }),
              h("span", { class: "muted small", text: row.label || row.detail || row.platform || "" }),
            ),
        },
        {
          key: "at",
          label: "Updated",
          render: (row) =>
            h("span", { class: "muted", title: fmt.dateTime(row.at), text: fmt.relative(row.at) }),
        },
        { key: "actions", label: "", class: "actions", render: (row) => actions(row, ctx) },
      ],
      rows,
      expand: (row) => (row.kind === "cloud" ? manifest(row) : null),
      empty: emptyState(
        "No saves here yet",
        "Turn on cloud saves in the launcher and they'll appear here.",
        "saves",
      ),
    });

    return card({
      body: h(
        "div",
        {},
        h(
          "div",
          { class: "card-head" },
          h("h2", { text: "My saves" }),
          h("span", { class: "muted small", text: fmt.plural(rows.length, "item") }),
          h("span", { class: "spacer" }),
          segmented({
            value: ctx.query.type ?? "",
            onChange: (type) => setQuery({ type }),
            options: [
              { label: "All", value: "" },
              { label: "Cloud", value: "cloud" },
              { label: "Backups", value: "legacy" },
              { label: "Emulation", value: "emulation" },
            ],
          }),
        ),
        table,
      ),
    });
  },
};

function actions(row, ctx) {
  const buttons = [];

  if (row.kind !== "cloud") {
    const base =
      row.kind === "legacy"
        ? `/portal/api/backups/${encodeURIComponent(row.id)}`
        : `/portal/api/emulation-saves/${encodeURIComponent(row.id)}`;
    buttons.push(
      h(
        "button",
        {
          class: "btn small",
          title: "Download",
          "aria-label": "Download",
          disabled: row.state === "pending",
          onclick: () => download(`${base}/download`),
        },
        icon("download", 14),
      ),
    );
  }

  buttons.push(
    h(
      "button",
      {
        class: "btn small danger",
        title: "Delete",
        "aria-label": "Delete",
        onclick: async () => {
          const ok = await confirm({
            title: "Delete this save?",
            body:
              row.kind === "cloud"
                ? `Your cloud save for ${fmt.gameName(row.game)} is removed from this server. The launcher uploads it again the next time you play — but if this machine no longer has the files, it is gone.`
                : `${fmt.bytes(row.sizeBytes)} for ${fmt.gameName(row.game)} is removed from this server. This cannot be undone.`,
            confirmLabel: "Delete",
            danger: true,
          });
          if (!ok) return;

          const path = {
            cloud: `/portal/api/cloud-saves/${encodeURIComponent(row.id)}`,
            legacy: `/portal/api/backups/${encodeURIComponent(row.id)}`,
            emulation: `/portal/api/emulation-saves/${encodeURIComponent(row.id)}`,
          }[row.kind];

          const result = await api.del(path);
          toast(`Deleted — ${fmt.bytes(result.freedBytes)} freed`, "good");
          location.reload();
        },
      },
      icon("trash", 14),
    ),
  );

  return buttons;
}

/** The files inside a cloud save, each downloadable on its own. */
async function manifest(row) {
  const files = await api.get(`/portal/api/cloud-saves/${encodeURIComponent(row.id)}/files`);
  if (!files.length) return emptyState("No files in this save", null, "file");

  return h(
    "table",
    { class: "sub" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { text: "File" }),
        h("th", { class: "num", text: "Size" }),
        h("th", { text: "Modified" }),
        h("th", {}),
      ),
    ),
    h(
      "tbody",
      {},
      ...files.map((file) =>
        h(
          "tr",
          {},
          h("td", { class: "truncate", title: `${file.rawPath}/${file.relativePath}` },
            h("span", { text: file.relativePath })),
          h(
            "td",
            { class: "num" },
            fmt.bytes(file.sizeBytes),
            file.stored ? null : h("span", { style: { marginLeft: "6px" } }, pill("missing", "critical")),
          ),
          h("td", { class: "muted", text: fmt.dateTime(file.lastModifiedAt) }),
          h(
            "td",
            { class: "actions" },
            file.stored
              ? h(
                  "button",
                  {
                    class: "btn small",
                    title: "Download this file",
                    onclick: () =>
                      download(
                        `/portal/api/cloud-saves/${encodeURIComponent(row.id)}/files/${file.hash}/download`,
                      ),
                  },
                  icon("download", 13),
                )
              : null,
          ),
        ),
      ),
    ),
  );
}
