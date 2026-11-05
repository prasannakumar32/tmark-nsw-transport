import { createServer } from "node:http";
import { supabaseKey } from "../shared/env.js";
import { readCarparks } from "../shared/supabase.js";

const port = Number(process.env.API_PORT || process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:9000,http://127.0.0.1:9000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function sendJson(res, status, body) {
  const content = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store",
  });
  res.end(content);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept");
  }
}

async function handleRequest(req, res) {
  applyCors(req, res);
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "OPTIONS") {
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
      return sendJson(res, 403, { error: "Origin not allowed" });
    }
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "api" });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/carparks") {
    try {
      return sendJson(res, 200, {
        source: "supabase",
        fetchedAt: new Date().toISOString(),
        carparks: await readCarparks(),
      });
    } catch (error) {
      console.error("Unable to load car parks from Supabase:", error.message);
      return sendJson(res, error.status === 401 || error.status === 403 ? 502 : error.status || 500, {
        error: error.message,
      });
    }
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "Not found" });
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be an integer between 1 and 65535.");
}
if (!supabaseKey) {
  throw new Error("SUPABASE_SECRET_KEY is not set. Configure it for the API service.");
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("REST API request failed:", error);
    if (res.headersSent) return res.destroy(error);
    sendJson(res, 500, { error: "Internal server error" });
  });
});

server.listen(port, host, () => {
  console.log(`TMark NSW REST API listening on http://${host}:${port}`);
});
