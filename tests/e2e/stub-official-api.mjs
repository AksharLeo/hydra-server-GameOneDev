import http from "node:http";
// Stands in for the official Hydra API that hydra-server calls to validate
// launcher access tokens.
const server = http.createServer((req, res) => {
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
