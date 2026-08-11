/** Operations that would otherwise only happen lazily, on demand. */

import { h, icon } from "../dom.js";
import * as fmt from "../format.js";
import { api } from "../api.js";
import { card, pill, confirm, toast } from "../components/ui.js";

export default {
  title: "Maintenance",
  subtitle: "Run the housekeeping this server normally does on its own",

  async render(ctx) {
    const { actions } = await api.get("/admin/api/maintenance");

    return h(
      "div",
      { class: "grid" },
      h(
        "div",
        { class: "grid cols-2" },
        ...actions.map((action) => actionCard(action, ctx)),
        exportCard(),
      ),
    );
  },
};

function actionCard(action, ctx) {
  const output = h("div", {});

  const run = async (event) => {
    if (action.danger) {
      const ok = await confirm({
        title: action.title,
        body: action.description,
        confirmLabel: "Run it",
        danger: true,
      });
      if (!ok) return;
    }

    const button = event.target;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Running…";

    try {
      const response = await api.post(`/admin/api/maintenance/${action.id}`, {});
      /* The report *is* the outcome — refresh only the chrome, or a
         re-render would wipe what the operator just asked for. */
      output.replaceChildren(result(response.result));
      toast(response.result.summary, "good");
      ctx.refreshChrome?.();
    } catch (error) {
      output.replaceChildren(
        h("div", { class: "alert critical" }, icon("critical", 16), h("div", { class: "detail", text: error.message })),
      );
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };

  return card({
    title: action.title,
    actions: h("button", { class: `btn ${action.danger ? "danger" : ""}`, text: "Run", onclick: run }),
    body: h(
      "div",
      { class: "card-body", style: { display: "grid", gap: "12px" } },
      h("p", { class: "muted small", style: { margin: 0 }, text: action.description }),
      action.danger ? h("div", {}, pill("destructive", "critical")) : null,
      output,
    ),
  });
}

/** Whatever the action reports, rendered generically: every tool returns a
 *  summary plus its own counters, and all of them are worth showing. */
function result(payload) {
  const rows = Object.entries(payload)
    .filter(([key]) => key !== "summary")
    .map(([key, value]) =>
      h(
        "div",
        { class: "row" },
        h("span", { class: "muted small", text: label(key) }),
        h("span", { class: "spacer", style: { flex: 1 } }),
        h("span", {
          class: "small num",
          text: key.toLowerCase().endsWith("bytes") ? fmt.bytes(value) : formatValue(value),
        }),
      ),
    );

  return h(
    "div",
    { class: "alert info" },
    icon("good", 16),
    h(
      "div",
      { class: "stack", style: { flex: 1 } },
      h("div", { class: "title", text: payload.summary }),
      ...rows,
    ),
  );
}

function formatValue(value) {
  if (Array.isArray(value)) return value.length ? `${value.length}` : "none";
  if (typeof value === "number") return fmt.number(value);
  return String(value);
}

function label(key) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
}

function exportCard() {
  return card({
    title: "Export inventory",
    actions: h("button", {
      class: "btn",
      text: "Download JSON",
      onclick: async (event) => {
        event.target.disabled = true;
        try {
          const data = await api.get("/admin/api/maintenance/export");
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = h("a", {
            href: url,
            download: `hydra-server-inventory-${new Date().toISOString().slice(0, 10)}.json`,
          });
          document.body.append(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          toast("Inventory downloaded", "good");
        } catch (error) {
          toast(error.message, "critical");
        } finally {
          event.target.disabled = false;
        }
      },
    }),
    body: h(
      "div",
      { class: "card-body" },
      h("p", {
        class: "muted small",
        style: { margin: 0 },
        text: "Every user, snapshot, backup and emulation save as JSON — what the server believes it holds. Useful for diffing two points in time or answering questions off-line. Not a backup of the save data itself; that is the storage directory.",
      }),
    ),
  });
}
