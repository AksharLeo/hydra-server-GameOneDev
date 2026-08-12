/**
 * The one place that talks to the server.
 *
 * Every call funnels through `request`, so a 401 anywhere in the panel ends
 * up as a single "signed out" event rather than each view inventing its own
 * recovery.
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Fired when the session is gone; main.js swaps in the login screen. */
export const events = new EventTarget();

function url(path, query) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, value);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function request(path, { method = "GET", body, raw, query, signal } = {}) {
  let response;
  try {
    response = await fetch(url(path, query), {
      method,
      signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError("Can't reach the server", 0);
  }

  if (response.status === 401) {
    events.dispatchEvent(new CustomEvent("unauthorized"));
    throw new ApiError("Session expired", 401);
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new ApiError(detail.message || response.statusText, response.status);
  }

  if (response.status === 204) return null;
  return response.json();
}

export const api = {
  get: (path, query, options) => request(path, { ...options, query }),
  post: (path, body) => request(path, { method: "POST", body }),
  put: (path, body) => request(path, { method: "PUT", body }),
  del: (path) => request(path, { method: "DELETE" }),
};

/**
 * Sends a file as the whole request body.
 *
 * Not multipart: the endpoints that take a file take exactly one, and the
 * bytes arriving unwrapped means a 2 GB database doesn't have to be
 * base64'd or re-assembled on the far side.
 */
export function upload(path, file) {
  return request(path, { method: "POST", raw: file });
}

/**
 * Opens a signed download in a new tab. Downloads are redirects to a
 * short-lived storage URL, so they can't be prefetched or embedded — the
 * click has to happen when the operator asks for the file.
 */
export function download(path) {
  window.open(path, "_blank", "noopener");
}
