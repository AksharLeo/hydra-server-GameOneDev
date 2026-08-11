import { h } from "../dom.js";
import { api } from "../api.js";

export default {
  title: "Sign in",

  render({ onSuccess }) {
    const password = h("input", {
      class: "input",
      type: "password",
      placeholder: "Admin password",
      autofocus: true,
      autocomplete: "current-password",
    });
    const error = h("div", { class: "error" });
    const button = h("button", { class: "btn primary", text: "Sign in" });

    const submit = async (event) => {
      event?.preventDefault();
      error.textContent = "";
      button.disabled = true;
      try {
        await api.post("/admin/api/login", { password: password.value });
        onSuccess();
      } catch (failure) {
        error.textContent = failure.message;
        password.select();
      } finally {
        button.disabled = false;
      }
    };

    const form = h(
      "form",
      { class: "login-card", onsubmit: submit },
      h(
        "div",
        { class: "row" },
        h("div", { class: "brand-mark", text: "H" }),
        h(
          "div",
          { class: "stack" },
          h("h1", { text: "Hydra Server" }),
          h("span", { class: "muted small", text: "admin console" }),
        ),
      ),
      error,
      password,
      button,
      h("p", {
        class: "muted small",
        style: { margin: 0 },
        text: "The password is HYDRA_ADMIN_PASSWORD from the server environment.",
      }),
    );

    return h("div", { class: "login-page" }, form);
  },
};
