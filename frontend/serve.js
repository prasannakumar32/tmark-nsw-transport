import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.FRONTEND_PORT || 9000);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("FRONTEND_PORT must be an integer between 1 and 65535.");
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", `http://${req.headers.host ?? host}`).pathname);
  } catch {
    res.writeHead(400);
    return res.end("Invalid URL path");
  }

  const filePath = path.resolve(distDir, `.${pathname}`);
  const relativePath = path.relative(distDir, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    res.writeHead(400);
    return res.end("Invalid URL path");
  }

  let resolvedPath = filePath;
  try {
    const stats = await fs.promises.stat(resolvedPath);
    if (!stats.isFile()) resolvedPath = path.join(distDir, "index.html");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Unable to read frontend file:", error);
      res.writeHead(500);
      return res.end("Unable to read frontend file");
    }
    if (path.extname(pathname)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    resolvedPath = path.join(distDir, "index.html");
  }

  try {
    const content = await fs.promises.readFile(resolvedPath);
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(resolvedPath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch (error) {
    console.error("Unable to serve frontend file:", error);
    if (res.headersSent) return res.destroy(error);
    res.writeHead(500);
    res.end("Unable to serve frontend file");
  }
});

server.listen(port, host, () => {
  console.log(`TMark NSW frontend listening on http://${host}:${port}`);
});
