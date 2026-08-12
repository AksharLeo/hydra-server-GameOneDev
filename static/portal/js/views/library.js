/** Achievements, custom images, shares and download sources. */

import { h } from "/assets/shared/js/dom.js";
import * as fmt from "/assets/shared/js/format.js";
import { api } from "/assets/shared/js/api.js";
import { card, gameCell, meter, emptyState } from "/assets/shared/js/components/ui.js";

export default {
  async render() {
    const library = await api.get("/portal/api/library");

    return h(
      "div",
      { class: "grid" },
      card({
        title: "Achievements",
        subtitle: fmt.plural(library.achievements.length, "game"),
        body: library.achievements.length
          ? table(
              ["Game", "Unlocked", "Synced"],
              library.achievements.map((entry) => [
                gameCell(entry.game, { link: false }),
                h(
                  "div",
                  { class: "row", style: { gap: "8px" } },
                  h("span", { class: "num", text: `${entry.unlocked} / ${entry.total}` }),
                  meter(entry.total ? entry.unlocked / entry.total : 0),
                ),
                h("span", { class: "muted", text: fmt.relative(entry.updatedAt) }),
              ]),
            )
          : emptyState("Nothing synced yet", "Achievements sync while you play.", "trophy"),
      }),
      card({
        title: "Custom images",
        body: library.artwork.length
          ? h(
              "div",
              { class: "card-body row wrap", style: { gap: "12px" } },
              ...library.artwork.map((art) =>
                h(
                  "div",
                  { class: "stack", style: { width: "150px" } },
                  h("img", {
                    src: art.url,
                    alt: "",
                    loading: "lazy",
                    style: {
                      width: "150px",
                      height: "70px",
                      objectFit: "cover",
                      borderRadius: "6px",
                      background: "var(--surface-3)",
                    },
                  }),
                  h("span", { class: "small truncate", text: fmt.gameName(art.game) }),
                  h("span", { class: "muted small", text: art.kind }),
                ),
              ),
            )
          : emptyState("No custom images", "Pick art in the launcher and it syncs here.", "image"),
      }),
      card({
        title: "Shared backups",
        body:
          library.sharedWithMe.length || library.sharedOut.length
            ? h(
                "div",
                {},
                library.sharedWithMe.length
                  ? h(
                      "div",
                      {},
                      h("div", { class: "card-body tight" }, h("strong", { text: "Shared with you" })),
                      table(
                        ["Game", "From", "Size", "When"],
                        library.sharedWithMe.map((entry) => [
                          gameCell(entry.game, { link: false }),
                          h("span", { text: entry.otherName ?? "another player" }),
                          h("span", { class: "num", text: fmt.bytes(entry.sizeBytes) }),
                          h("span", { class: "muted", text: fmt.relative(entry.createdAt) }),
                        ]),
                      ),
                    )
                  : null,
                library.sharedOut.length
                  ? h(
                      "div",
                      {},
                      h("div", { class: "card-body tight" }, h("strong", { text: "You shared" })),
                      table(
                        ["Game", "With", "Size", "When"],
                        library.sharedOut.map((entry) => [
                          gameCell(entry.game, { link: false }),
                          h("span", { text: entry.otherName ?? "another player" }),
                          h("span", { class: "num", text: fmt.bytes(entry.sizeBytes) }),
                          h("span", { class: "muted", text: fmt.relative(entry.createdAt) }),
                        ]),
                      ),
                    )
                  : null,
              )
            : emptyState("Nothing shared", "Backups you share in the launcher show up here.", "share"),
      }),
      card({
        title: "Download sources",
        subtitle: "synced across your devices",
        body: library.downloadSources.length
          ? table(
              ["Name", "URL", "Added"],
              library.downloadSources.map((entry) => [
                h("span", { text: entry.name || "—" }),
                h("span", { class: "mono truncate", title: entry.url, text: entry.url }),
                h("span", { class: "muted", text: fmt.relative(entry.createdAt) }),
              ]),
            )
          : emptyState("No sources synced", null, "folder"),
      }),
    );
  },
};

function table(headers, rows) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "data" },
      h("thead", {}, h("tr", {}, ...headers.map((label) => h("th", { text: label })))),
      h("tbody", {}, ...rows.map((cells) => h("tr", {}, ...cells.map((cell) => h("td", {}, cell))))),
    ),
  );
}
