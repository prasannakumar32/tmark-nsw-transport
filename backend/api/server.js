import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { backendDir, supabaseKey } from "../shared/env.js";
import { readCarparks, readDepartures } from "../shared/supabase.js";

const trainConfigPath = path.join(backendDir, "workflow", "train-config.json");
const trainConfig = JSON.parse(fs.readFileSync(trainConfigPath, "utf8"));
const trainStations = trainConfig.stations.map(({ stopId, name }) => ({
  stopId: String(stopId),
  name,
}));

const port = Number(process.env.API_PORT || process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:9000,http://127.0.0.1:9000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function sendJson(res, status, body, headers = {}) {
  const content = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(content);
}

function sendUpstreamError(res, error, message) {
  const retryAfterMilliseconds = Number(error.retryAfterMilliseconds);
  const headers = Number.isFinite(retryAfterMilliseconds) && retryAfterMilliseconds >= 0
    ? { "Retry-After": String(Math.ceil(retryAfterMilliseconds / 1000)) }
    : {};
  return sendJson(res, 502, { error: message }, headers);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept");
    res.setHeader("Access-Control-Expose-Headers", "Retry-After");
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
      return sendUpstreamError(res, error, "Unable to load car park data from the upstream service.");
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/trains/stations") {
    return sendJson(res, 200, { stations: trainStations });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/trains") {
    const stopId = requestUrl.searchParams.get("stopId");
    if (!stopId || !trainStations.some((station) => station.stopId === stopId)) {
      return sendJson(res, 400, { error: "A valid stopId is required." });
    }
    try {
      const departures = await readDepartures(stopId);
      return sendJson(res, 200, {
        source: "supabase",
        fetchedAt: new Date().toISOString(),
        stopId,
        departures,
      });
    } catch (error) {
      console.error(`Unable to load train departures for stop ${stopId}:`, error.message);
      return sendUpstreamError(res, error, "Unable to load train departures from the upstream service.");
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
