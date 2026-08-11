/**
 * Portal sign-in.
 *
 * The form asks for the Hydra account a player already has, because expecting
 * someone to dig an access token out of their launcher to look at their own
 * saves is not a sign-in flow. The server forwards the credentials to the
 * official Hydra API once and keeps only a session of its own.
 */

import { h } from "/assets/shared/js/dom.js";
import { api } from "/assets/shared/js/api.js";

export default {
  render({ onSuccess }) {
    const email = h("input", {
      class: "input",
      type: "email",
      placeholder: "Hydra email",
      autocomplete: "username",
      autofocus: true,
    });
    const password = h("input", {
      class: "input",
      type: "password",
      placeholder: "Password",
      autocomplete: "current-password",
    });
    const token = h("input", {
      class: "input",
      type: "password",
      placeholder: "Launcher access token",
      autocomplete: "off",
    });
    const error = h("div", { class: "error" });
    const button = h("button", { class: "btn primary", type: "submit", text: "Sign in" });

    const submit = async (event) => {
      event.preventDefault();
      error.textContent = "";
      button.disabled = true;

      const body = token.value.trim()
        ? { accessToken: token.value.trim() }
        : { email: email.value.trim(), password: password.value };

      try {
        await api.post("/portal/api/login", body);
        onSuccess();
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        button.disabled = false;
      }
    };

    return h(
      "div",
      { class: "login-page" },
      h(
        "form",
        { class: "login-card", onsubmit: submit },
        h(
          "div",
          { class: "row" },
          h("div", { class: "brand-mark", text: "H" }),
          h(
            "div",
            { class: "stack" },
            h("h1", { text: "My Hydra saves" }),
            h("span", { class: "muted small", text: "sign in with your Hydra account" }),
          ),
        ),
        error,
        email,
        password,
        button,
        h(
          "details",
          { class: "small muted" },
          h("summary", { style: { cursor: "pointer" }, text: "Sign in another way" }),
          h(
            "div",
            { class: "stack", style: { gap: "8px", marginTop: "10px" } },
            h("span", {
              text: "Paste a launcher access token instead, or ask the server admin for a one-time sign-in link.",
            }),
            token,
          ),
        ),
        h("p", {
          class: "muted small",
          style: { margin: 0 },
          text: "Your password goes to the official Hydra API to prove who you are, and is never stored here.",
        }),
      ),
    );
  },
};
