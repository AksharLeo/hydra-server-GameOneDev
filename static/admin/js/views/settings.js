/** Runtime settings: environment default, saved override, value in force. */

import { h } from "../dom.js";
import * as fmt from "../format.js";
import { api } from "../api.js";
import { card, pill, confirm, toast } from "../components/ui.js";

const GIB = 2 ** 30;

export default {
  title: "Settings",
  subtitle: "Applied immediately and kept across restarts",

  async render(ctx) {
    const data = await api.get("/admin/api/settings");

    const quota = h("input", {
      class: "input",
      type: "number",
      min: "0",
      step: "0.1",
      value: data.current.maxBytesPerUser ? +(data.current.maxBytesPerUser / GIB).toFixed(2) : 0,
    });
    const backups = h("input", {
      class: "input",
      type: "number",
      min: "1",
      step: "1",
      value: data.current.backupsPerGameLimit,
    });
    const allowed = h("input", {
      class: "input",
      type: "text",
      placeholder: "ids or usernames, comma separated",
      value: data.current.allowedUsers.join(", "),
    });

    const save = async (event) => {
      const button = event.target;
      button.disabled = true;
      try {
        await api.put("/admin/api/settings", {
          maxBytesPerUser: Math.max(0, Math.round(Number(quota.value || 0) * GIB)),
          backupsPerGameLimit: Number(backups.value || 1),
          allowedUsers: allowed.value.split(",").map((entry) => entry.trim()).filter(Boolean),
        });
        toast("Settings saved — in force now", "good");
        ctx.refresh();
      } catch (error) {
        toast(error.message, "critical");
      } finally {
        button.disabled = false;
      }
    };

    const reset = async () => {
      const ok = await confirm({
        title: "Clear panel overrides?",
        body: "Every setting goes back to the value from the server environment.",
        confirmLabel: "Reset",
      });
      if (!ok) return;
      await api.del("/admin/api/settings");
      toast("Overrides cleared", "good");
      ctx.refresh();
    };

    return h(
      "div",
      { class: "grid split" },
      card({
        title: "Limits and access",
        subtitle: data.overrides.length ? "overridden here" : "using environment values",
        body: h(
          "div",
          { class: "card-body", style: { display: "grid", gap: "16px" } },
          field(
            "Per-user storage quota (GiB)",
            quota,
            `0 means unlimited. Environment default: ${fmt.quota(data.defaults.maxBytesPerUser)}.`,
          ),
          field(
            "Legacy backups kept per game",
            backups,
            `Frozen backups are exempt. Environment default: ${data.defaults.backupsPerGameLimit}. Cloud Save V2 keeps one snapshot per game regardless.`,
          ),
          field(
            "Allowed users",
            allowed,
            data.defaults.allowedUsers.length
              ? `Environment default: ${data.defaults.allowedUsers.join(", ")}.`
              : "Empty means everyone with a valid official Hydra login may use this server.",
          ),
          h(
            "div",
            { class: "row", style: { gap: "8px" } },
            h("button", { class: "btn primary", text: "Save changes", onclick: save }),
            h("button", { class: "btn", text: "Reset to environment", onclick: reset }),
          ),
        ),
      }),
      h(
        "div",
        { class: "grid" },
        card({
          title: "In force",
          body: h(
            "div",
            { class: "card-body" },
            h(
              "dl",
              { class: "kv" },
              h("dt", { text: "Quota" }),
              h("dd", {}, fmt.quota(data.current.maxBytesPerUser), source(data, "max_bytes_per_user")),
              h("dt", { text: "Backups per game" }),
              h("dd", {}, String(data.current.backupsPerGameLimit), source(data, "backups_per_game_limit")),
              h("dt", { text: "Allowed users" }),
              h(
                "dd",
                {},
                data.current.allowedUsers.length ? data.current.allowedUsers.join(", ") : "everyone",
                source(data, "allowed_users"),
              ),
            ),
          ),
        }),
        card({
          title: "Environment",
          subtitle: "read-only — set before the server starts",
          body: h(
            "div",
            { class: "card-body" },
            h(
              "dl",
              { class: "kv" },
              h("dt", { text: "Public URL" }),
              h("dd", { class: "mono small", text: data.environment.publicUrl }),
              h("dt", { text: "Bind address" }),
              h("dd", { class: "mono small", text: data.environment.bind }),
              h("dt", { text: "Official Hydra API" }),
              h("dd", { class: "mono small", text: data.environment.officialApiUrl }),
              h("dt", { text: "Data directory" }),
              h("dd", { class: "mono small", text: data.environment.dataDir }),
            ),
          ),
        }),
      ),
    );
  },
};

function field(label, input, hint) {
  return h(
    "div",
    { class: "field" },
    h("label", { text: label }),
    input,
    h("span", { class: "hint", text: hint }),
  );
}

/** Marks which layer a value came from, so nothing is mysterious. */
function source(data, key) {
  const override = data.overrides.find((entry) => entry.key === key);
  return h(
    "span",
    { style: { marginLeft: "8px" } },
    override ? pill(`overridden ${fmt.relative(override.updatedAt)}`, "accent") : pill("from environment"),
  );
}
