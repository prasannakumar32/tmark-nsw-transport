import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(backendDir, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    let value = entry.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const {
  TFNSW_API_KEY,
  TFNSW_BASE_URL = "https://api.transport.nsw.gov.au/v1",
  PORT = 4000,
  CACHE_SECONDS = 30,
} = process.env;

const frontendDir = path.resolve(backendDir, "../frontend/dist");

function sendJson(res, status, body) {
  const content = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
  });
  res.end(content);
}

async function sendFile(req, res, filePath) {
  const content = await fs.promises.readFile(filePath);
  const contentType = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  }[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": content.length });
  res.end(req.method === "HEAD" ? undefined : content);
}

// ---------- upstream helpers ----------
async function tfnsw(pathAndQuery) {
  const apiKey = TFNSW_API_KEY.trim().replace(/^apikey\s+/i, "");
  const res = await fetch(`${TFNSW_BASE_URL}${pathAndQuery}`, {
    headers: { Authorization: `apikey ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Transport NSW API ${res.status} ${res.statusText} for ${pathAndQuery}`);
    err.status = res.status;
    err.detail = body.slice(0, 300);
    throw err;
  }
  return res.json();
}

// The consolidated endpoint may return an array, an object keyed by id, or wrap the list.
function toArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["facilities", "data", "results", "carparks"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    return Object.values(payload).filter((v) => v && typeof v === "object");
  }
  return [];
}

const num = (v) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? n : null;
};

const sydneyTimeFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  timeZoneName: "shortOffset",
});

function sydneyOffsetMilliseconds(timestamp) {
  const zoneName = sydneyTimeFormat.formatToParts(new Date(timestamp))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zoneName ?? "");
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return (match[1] === "-" ? -1 : 1) * minutes * 60 * 1000;
}

function normaliseTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  let timestamp = Date.parse(value);
  if (/^\d{9,10}$/.test(String(value))) {
    const localTimestamp = Date.UTC(2000, 0, 1) + Number(value) * 1000;
    timestamp = localTimestamp;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      timestamp = localTimestamp - sydneyOffsetMilliseconds(timestamp);
    }
  }
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

// Availability = spots - occupancy.total (Transport NSW recommended calculation)
function normalise(raw) {
  const spots = num(raw.spots);
  const occupied = num(raw.occupancy?.total);
  const available = spots !== null && occupied !== null ? Math.max(spots - occupied, 0) : null;
  const percentFull =
    spots && occupied !== null ? Math.min(Math.round((occupied / spots) * 100), 100) : null;
  const name = String(raw.facility_name ?? "")
    .replace(/^\s*park\s*(?:&|and)\s*ride\s*[-–—:|,;]?\s*/i, "")
    .replace(/\s*\(\s*park\s*(?:&|and)\s*ride\s*\)\s*/gi, " ")
    .replace(/\s*park\s*(?:&|and)\s*ride\s*/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:|–—-]+|[\s,;:|–—-]+$/g, "")
    .trim();
  return {
    id: String(raw.facility_id ?? raw.tfnsw_facility_id ?? (name || "unknown")),
    name: name || "Unknown",
    tfnswId: raw.tfnsw_facility_id ?? null,
    spots,
    occupied,
    available,
    percentFull,
    updated: normaliseTimestamp(raw.message_date ?? raw.time),
  };
}

async function fetchAllFacilities() {
  // 1) Preferred: one call for everything.
  try {
    return toArray(await tfnsw("/carpark/full-list"));
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 429) throw err;
    console.warn("full-list failed, falling back to per-facility calls:", err.message);
  }

  // 2) Fallback: list facilities, then fetch each one.
  const list = await tfnsw("/carpark"); // { "1": "Name", "2": "Name", ... }
  const ids = Object.keys(list);
  const results = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.allSettled(
      ids.slice(i, i + 5).map((id) => tfnsw(`/carpark?facility=${encodeURIComponent(id)}`))
    );
    for (const r of batch) if (r.status === "fulfilled") results.push(r.value);
  }
  return results;
}

// ---------- API ----------
let cache = { at: 0, body: null };

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/carparks") {
  if (!TFNSW_API_KEY) {
      return sendJson(res, 500, {
      error: "TFNSW_API_KEY is not set. Add it to backend/.env.",
    });
  }
  try {
    if (cache.body && Date.now() - cache.at < Number(CACHE_SECONDS) * 1000) {
        return sendJson(res, 200, cache.body);
    }
    const carparks = (await fetchAllFacilities())
      .map(normalise)
      .sort((a, b) => a.name.localeCompare(b.name));
    cache = {
      at: Date.now(),
      body: { source: "live", fetchedAt: new Date().toISOString(), carparks },
    };
      return sendJson(res, 200, cache.body);
  } catch (err) {
    console.error(err.message, err.detail ?? "");
    const authFail = err.status === 401 || err.status === 403;
      return sendJson(res, authFail ? 502 : err.status || 502, {
      error: authFail
        ? "Transport NSW rejected the API key. Check TFNSW_API_KEY and that the Car Park API is added to your application."
        : err.message,
    });
  }
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "Not found" });
  }

  if (req.method === "GET" || req.method === "HEAD") {
    let pathname;
    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      return sendJson(res, 400, { error: "Invalid URL path" });
    }
    if (pathname.startsWith("/vendor/")) {
      return res.writeHead(404).end("Not found");
    }
    const filePath = path.resolve(frontendDir, `.${pathname}`);
    const relativePath = path.relative(frontendDir, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return sendJson(res, 400, { error: "Invalid URL path" });
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return sendFile(req, res, filePath);
    }
    if (!pathname.startsWith("/api/")) {
      return sendFile(req, res, path.join(frontendDir, "index.html"));
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (res.headersSent) return res.destroy(err);
    sendJson(res, 500, { error: "Internal server error" });
  });
});

server.listen(PORT, () =>
  console.log(`TMark NSW Transport server on http://localhost:${PORT}`)
);
