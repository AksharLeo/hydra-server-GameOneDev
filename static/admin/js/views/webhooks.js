/** Outbound webhooks: where the server should shout when something happens. */

import { h, icon } from "/assets/shared/js/dom.js";
import * as fmt from "/assets/shared/js/format.js";
import { api } from "/assets/shared/js/api.js";
import {
  card,
  pill,
  emptyState,
  openModal,
  confirm,
  toast,
} from "/assets/shared/js/components/ui.js";
import { dataTable } from "/assets/shared/js/components/table.js";

export default {
  title: "Webhooks",
  subtitle: "Send events to Discord, a homelab notifier, or anything that takes a POST",

  async render(ctx) {
    const data = await api.get("/admin/api/webhooks");

    return h(
      "div",
      { class: "grid" },
      card({
        title: "Endpoints",
        subtitle: fmt.plural(data.webhooks.length, "hook"),
        actions: h("button", {
          class: "btn primary",
          text: "Add webhook",
          onclick: () => editor({ ctx, kinds: data.kinds }),
        }),
        body: data.webhooks.length
          ? dataTable({
              columns: [
                {
                  key: "url",
                  label: "Endpoint",
                  render: (row) =>
                    h(
                      "div",
                      { class: "stack", style: { minWidth: 0 } },
                      h("span", { class: "strong truncate", text: row.label || row.url }),
                      h("span", { class: "mono muted small truncate", text: row.url }),
                    ),
                },
                { key: "format", label: "Format", render: (row) => pill(row.format) },
                {
                  key: "filters",
                  label: "Sends",
                  render: (row) =>
                    h(
                      "div",
                      { class: "row wrap", style: { gap: "4px" } },
                      ...(row.kinds.length
                        ? row.kinds.map((kind) => pill(kind))
                        : [pill("everything", "accent")]),
                      row.minSeverity !== "info" ? pill(`≥ ${row.minSeverity}`, "warning") : null,
                    ),
                },
                {
                  key: "status",
                  label: "Last delivery",
                  render: (row) => status(row),
                },
                {
                  key: "counts",
                  label: "Delivered",
                  align: "right",
                  render: (row) => fmt.number(row.deliveredCount),
                },
                {
                  key: "actions",
                  label: "",
                  class: "actions",
                  render: (row) => [
                    h("button", {
                      class: "btn small",
                      text: "Test",
                      onclick: async (event) => {
                        event.target.disabled = true;
                        try {
                          const result = await api.post(
                            `/admin/api/webhooks/${encodeURIComponent(row.id)}/test`,
                          );
                          toast(`Delivered — HTTP ${result.status} in ${result.elapsedMs} ms`, "good");
                        } catch (error) {
                          toast(error.message, "critical");
                        } finally {
                          event.target.disabled = false;
                          ctx.refresh();
                        }
                      },
                    }),
                    h("button", {
                      class: "btn small",
                      text: "Edit",
                      onclick: () => editor({ ctx, kinds: data.kinds, webhook: row }),
                    }),
                    h(
                      "button",
                      {
                        class: "btn small danger",
                        "aria-label": "Delete",
                        title: "Delete",
                        onclick: async () => {
                          const ok = await confirm({
                            title: "Delete this webhook?",
                            body: `Nothing more will be sent to ${row.url}.`,
                            confirmLabel: "Delete",
                            danger: true,
                          });
                          if (!ok) return;
                          await api.del(`/admin/api/webhooks/${encodeURIComponent(row.id)}`);
                          toast("Webhook deleted", "good");
                          ctx.refresh();
                        },
                      },
                      icon("trash", 14),
                    ),
                  ],
                },
              ],
              rows: data.webhooks,
            })
          : emptyState(
              "No webhooks yet",
              "Add one to get a message whenever something happens here.",
              "share",
            ),
      }),
      card({
        title: "What gets sent",
        body: h(
          "div",
          { class: "card-body", style: { display: "grid", gap: "10px" } },
          h("p", {
            class: "muted small",
            style: { margin: 0 },
            text: "A JSON hook receives the full event; Discord and Slack hooks receive a rendered one-line message. Set a secret and each delivery carries an X-Hydra-Signature header — HMAC-SHA256 of the body — so the receiver can verify it came from here.",
          }),
          h("pre", {
            class: "mono",
            style: {
              margin: 0,
              padding: "12px",
              background: "var(--surface-2)",
              borderRadius: "8px",
              overflowX: "auto",
            },
            text: JSON.stringify(
              {
                server: { name: "hydra-server", version: "…", publicUrl: "…" },
                event: {
                  at: "2026-08-11T10:20:30Z",
                  kind: "cloud_save.committed",
                  severity: "info",
                  actor: "user:1234",
                  userId: "1234",
                  shop: "steam",
                  objectId: "440",
                  summary: "Synced a cloud save (v3, 12 files)",
                  detail: { version: 3, fileCount: 12 },
                  sizeBytes: 8402931,
                },
              },
              null,
              2,
            ),
          }),
          h("p", {
            class: "muted small",
            style: { margin: 0 },
            text: "A hook that fails 20 times in a row switches itself off — saving it again turns it back on.",
          }),
        ),
      }),
    );
  },
};

function status(row) {
  if (!row.lastDeliveryAt) return h("span", { class: "muted", text: "never" });

  const failed = row.lastStatus === "failed";
  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "row", style: { gap: "6px" } },
      failed ? pill("failed", "critical") : pill(`HTTP ${row.lastStatus}`, "good"),
      row.enabled ? null : pill("disabled", "warning"),
    ),
    h("span", {
      class: "muted small truncate",
      title: row.lastError ?? "",
      text: failed && row.lastError ? row.lastError : fmt.relative(row.lastDeliveryAt),
    }),
  );
}

/** Create/edit form. Same modal both ways — one shape to learn. */
function editor({ ctx, kinds, webhook }) {
  const label = field("Name", "text", webhook?.label ?? "", "Shown in this list only.");
  const url = field("URL", "url", webhook?.url ?? "", "Where to POST. https:// unless it's on your LAN.");
  const secret = field(
    "Signing secret",
    "password",
    "",
    webhook?.hasSecret
      ? "A secret is set. Leave blank to keep it, or type a new one."
      : "Optional. Adds an HMAC-SHA256 signature header to every delivery.",
  );

  const format = h(
    "select",
    { class: "input" },
    ...["json", "discord", "slack"].map((value) =>
      h("option", { value, selected: webhook?.format === value, text: value }),
    ),
  );

  const severity = h(
    "select",
    { class: "input" },
    ...["info", "warning", "critical"].map((value) =>
      h("option", {
        value,
        selected: (webhook?.minSeverity ?? "info") === value,
        text: value === "info" ? "everything" : `${value} and above`,
      }),
    ),
  );

  /* Prefixes rather than exact kinds: "cloud_save." keeps matching when a new
     cloud-save event is added later. */
  const selected = new Set(webhook?.kinds ?? []);
  const kindBoxes = (
    kinds.length ? kinds : ["cloud_save.", "backup.", "user.", "admin.", "auth.", "system."]
  ).map(
    (kind) => {
      const input = h("input", { type: "checkbox", checked: selected.has(kind) });
      return { kind, input, node: h("label", { class: "checkline" }, input, h("span", { text: kind })) };
    },
  );

  openModal({
    title: webhook ? "Edit webhook" : "Add webhook",
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      label.node,
      url.node,
      h(
        "div",
        { class: "grid cols-2", style: { gap: "12px" } },
        h("div", { class: "field" }, h("label", { text: "Payload format" }), format),
        h("div", { class: "field" }, h("label", { text: "Minimum severity" }), severity),
      ),
      secret.node,
      h(
        "div",
        { class: "field" },
        h("label", { text: "Only these event families" }),
        h("span", { class: "hint", text: "Nothing ticked means every event." }),
        ...kindBoxes.map((entry) => entry.node),
      ),
    ),
    actions: (close) => [
      h("button", { class: "btn", text: "Cancel", onclick: () => close() }),
      h("button", {
        class: "btn primary",
        text: webhook ? "Save" : "Add",
        onclick: async (event) => {
          const body = {
            label: label.input.value.trim(),
            url: url.input.value.trim(),
            format: format.value,
            minSeverity: severity.value,
            kinds: kindBoxes.filter((entry) => entry.input.checked).map((entry) => entry.kind),
            enabled: true,
          };
          /* An untouched secret field must not wipe a stored secret. */
          if (secret.input.value) body.secret = secret.input.value;

          event.target.disabled = true;
          try {
            if (webhook) await api.put(`/admin/api/webhooks/${encodeURIComponent(webhook.id)}`, body);
            else await api.post("/admin/api/webhooks", body);
            close();
            toast(webhook ? "Webhook saved" : "Webhook added", "good");
            ctx.refresh();
          } catch (error) {
            toast(error.message, "critical");
            event.target.disabled = false;
          }
        },
      }),
    ],
  });
}

function field(labelText, type, value, hint) {
  const input = h("input", { class: "input", type, value });
  return {
    input,
    node: h(
      "div",
      { class: "field" },
      h("label", { text: labelText }),
      input,
      h("span", { class: "hint", text: hint }),
    ),
  };
}
