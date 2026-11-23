// Runs the real Function routes under plain Node with an in-memory database.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { application } from "../functions/routes.mjs";
import { createFakeDb, BackendError } from "./fake-db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/plain; charset=utf-8" };

const PORT = Number(process.env.PORT || 8130);
const handle = application({
  db: createFakeDb(),
  BackendError,
  secrets: {
    portal: process.env.PORTAL_SECRET || "local-portal-secret",
    offerwall: process.env.OFFERWALL_SECRET || "local-offerwall-secret",
    admin: process.env.ADMIN_KEY || "local-admin-key",
  },
  sandbox: process.env.SANDBOX !== "0",
});

http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (!pathname.startsWith("/functions/v1/app/")) {
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  try {
    const response = await handle({ request, requestId: "local" });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status = error instanceof BackendError && error.status ? error.status : 500;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.code || "server_error" }));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`TaskMint function harness on http://127.0.0.1:${PORT}/functions/v1/app/api/health`);
});
