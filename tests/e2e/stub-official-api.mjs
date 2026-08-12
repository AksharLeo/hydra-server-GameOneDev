import http from "node:http";
// Stands in for the official Hydra API that hydra-server calls to validate
// launcher access tokens.
const server = http.createServer((req, res) => {
  // The portal's sign-in form posts here, exactly as the launcher's own
  // sign-in does: credentials in, an access token back.
  if (req.url.startsWith("/auth/login") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { email, password } = JSON.parse(body || "{}");
      if (password !== "hunter2") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "invalid credentials" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accessToken: String(email).split("@")[0], refreshToken: "r" }));
    });
    return;
  }

  if (req.url.startsWith("/profile/me")) {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth === "Bearer bad") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "unauthorized" }));
    }
    const id = auth.slice("Bearer ".length);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id, username: id, displayName: id }));
  }
  res.writeHead(404).end("{}");
});
server.listen(9911, () => console.log("stub official api on 9911"));
