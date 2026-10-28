import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
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
  SUPABASE_URL = "https://iaqwzvnjpfdojnbrlgpz.supabase.co",
  SUPABASE_SECRET_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 4000,
} = process.env;

const adaptiveDelayConfigPath = path.join(backendDir, "adaptive-delay.json");
const adaptiveDelayConfig = JSON.parse(fs.readFileSync(adaptiveDelayConfigPath, "utf8"));
if (!adaptiveDelayConfig || typeof adaptiveDelayConfig.timeZone !== "string"
  || !adaptiveDelayConfig.timeZone || !Array.isArray(adaptiveDelayConfig.windows)
  || adaptiveDelayConfig.windows.length === 0) {
  throw new Error(`Invalid adaptive delay configuration in ${adaptiveDelayConfigPath}.`);
}

let previousWindowEnd = 0;
const adaptiveDelayWindows = adaptiveDelayConfig.windows.map((window) => {
  const { startHour, endHour, delaySeconds } = window;
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)
    || startHour !== previousWindowEnd || endHour <= startHour || endHour > 24
    || !Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    throw new Error(`Invalid or incomplete adaptive delay window in ${adaptiveDelayConfigPath}.`);
  }
  previousWindowEnd = endHour;
  return { startHour, endHour, delayMilliseconds: delaySeconds * 1000 };
});
if (previousWindowEnd !== 24) {
  throw new Error(`Adaptive delay windows must cover all 24 hours in ${adaptiveDelayConfigPath}.`);
}

const supabaseKey = SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY;
const frontendDir = path.resolve(backendDir, "../frontend/dist");
const facilityIds = ["24", "26", "27", "28", "29", "30", "31"];
const tableName = "car_spots";
const manualSyncCooldownMilliseconds = 25_000;
const fallbackRequestDelayMilliseconds = 1_000;
const initialRateLimitBackoffMilliseconds = 5 * 60_000;
const maximumRateLimitBackoffMilliseconds = 6 * 60 * 60_000;

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

function requiredEnv(value, name) {
  if (!value) throw new Error(`${name} is not set. Add it to backend/.env.`);
  return value;
}

async function requestJson(url, options, serviceName) {
  const response = await fetch(url, options);
  const responseText = await response.text();
  if (!response.ok) {
    const error = new Error(`${serviceName} request failed (${response.status}): ${responseText.slice(0, 300)}`);
    error.status = response.status;
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterSeconds = Number(retryAfter);
      if (retryAfter && Number.isFinite(retryAfterSeconds)) {
        error.retryAfterMilliseconds = Math.max(retryAfterSeconds * 1000, 0);
      } else if (retryAfter) {
        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) error.retryAfterMilliseconds = Math.max(retryAt - Date.now(), 0);
      }
    }
    throw error;
  }
  return responseText ? JSON.parse(responseText) : null;
}

const sydneyTimeFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  timeZoneName: "shortOffset",
});
const sydneyHourFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: adaptiveDelayConfig.timeZone,
  hour: "numeric",
  hourCycle: "h23",
});

function scheduledSyncDelayMilliseconds(timestamp = Date.now()) {
  const hourPart = sydneyHourFormat.formatToParts(new Date(timestamp))
    .find((part) => part.type === "hour");
  if (!hourPart) throw new Error("Unable to determine the current configured timezone hour.");

  const hour = Number(hourPart.value);
  if (!Number.isFinite(hour)) throw new Error("Unable to determine the current configured timezone hour.");

  const window = adaptiveDelayWindows.find(({ startHour, endHour }) => hour >= startHour && hour < endHour);
  if (!window) throw new Error(`No adaptive delay configured for hour ${hour}.`);
  return window.delayMilliseconds;
}

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

function requiredNumber(value, label, facilityId) {
  const number = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(number)) {
    throw new Error(`Invalid ${label} for Transport NSW facility ${facilityId}.`);
  }
  return number;
}

function cleanFacilityName(value) {
  return String(value ?? "")
    .replace(/^\s*park\s*(?:&|and)\s*ride\s*[-–—:|,;]?\s*/i, "")
    .trim();
}

function normaliseFacility(raw, requestedId) {
  const facilityId = String(raw.facility_id ?? raw.tfnsw_facility_id ?? requestedId);
  const totalSpots = requiredNumber(raw.spots, "capacity", facilityId);
  const occupied = requiredNumber(raw.occupancy?.total, "occupancy", facilityId);
  const facilityName = cleanFacilityName(raw.facility_name);
  if (!facilityName) throw new Error(`Transport NSW returned no name for facility ${facilityId}.`);

  return {
    id: requiredNumber(facilityId, "facility ID", facilityId),
    facility_id: facilityId,
    facility_name: facilityName,
    suburb: raw.location?.suburb ?? null,
    address: raw.location?.address ?? null,
    total_spots: totalSpots,
    occupied,
    available: totalSpots - occupied,
    message_date: normaliseTimestamp(raw.MessageDate ?? raw.message_date ?? raw.time),
    updated_at: new Date().toISOString(),
  };
}

async function fetchFacility(facilityId) {
  const apiKey = requiredEnv(TFNSW_API_KEY, "TFNSW_API_KEY").trim().replace(/^apikey\s+/i, "");
  const url = `${TFNSW_BASE_URL}/carpark?facility=${encodeURIComponent(facilityId)}`;
  const payload = await requestJson(url, {
    headers: { Authorization: `apikey ${apiKey}`, Accept: "application/json" },
  }, "Transport NSW");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Transport NSW returned invalid data for facility ${facilityId}.`);
  }
  return normaliseFacility(payload, facilityId);
}

function toFacilityArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["facilities", "data", "results", "carparks"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    return Object.values(payload).filter((value) => value && typeof value === "object");
  }
  return [];
}

function facilityIdOf(raw) {
  const id = raw?.facility_id ?? raw?.tfnsw_facility_id;
  return id == null ? null : String(id);
}

async function fetchFacilitiesIndividually(ids) {
  const facilities = [];
  for (const [index, facilityId] of ids.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, fallbackRequestDelayMilliseconds));
    }
    facilities.push(await fetchFacility(facilityId));
  }
  return facilities;
}

async function fetchRequestedFacilities() {
  const apiKey = requiredEnv(TFNSW_API_KEY, "TFNSW_API_KEY").trim().replace(/^apikey\s+/i, "");
  const url = `${TFNSW_BASE_URL}/carpark/full-list`;
  let payload;
  try {
    payload = await requestJson(url, {
      headers: { Authorization: `apikey ${apiKey}`, Accept: "application/json" },
    }, "Transport NSW");
  } catch (error) {
    if ([401, 403, 429].includes(error.status)) throw error;
    console.warn("TfNSW full-list endpoint failed; using spaced facility requests:", error.message);
    return fetchFacilitiesIndividually(facilityIds);
  }

  const requestedIds = new Set(facilityIds);
  const byId = new Map();
  for (const raw of toFacilityArray(payload)) {
    const id = facilityIdOf(raw);
    if (id && requestedIds.has(id)) byId.set(id, normaliseFacility(raw, id));
  }

  const missingIds = facilityIds.filter((id) => !byId.has(id));
  if (missingIds.length) {
    const missingFacilities = await fetchFacilitiesIndividually(missingIds);
    for (const facility of missingFacilities) byId.set(facility.facility_id, facility);
  }
  return facilityIds.map((id) => byId.get(id));
}

function supabaseHeaders(extraHeaders = {}) {
  const key = requiredEnv(supabaseKey, "SUPABASE_SECRET_KEY");
  const headers = {
    apikey: key,
    Accept: "application/json",
    ...extraHeaders,
  };
  if (!key.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${key}`;
  }
  return {
    ...headers,
  };
}

async function fetchCarparksFromSupabase() {
  const url = new URL(`/rest/v1/${tableName}`, requiredEnv(SUPABASE_URL, "SUPABASE_URL"));
  url.searchParams.set(
    "select",
    "id,facility_id,facility_name,suburb,address,total_spots,occupied,available,message_date,updated_at",
  );
  url.searchParams.set("order", "facility_name.asc");
  const startedAt = new Date();
  const started = performance.now();
  let rows;
  try {
    rows = await requestJson(url, {
      headers: supabaseHeaders(),
    }, "Supabase");
    if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid car park list.");
  } catch (error) {
    console.error(
      `[Supabase] Fetch failed (started ${startedAt.toISOString()}, elapsed ${(performance.now() - started).toFixed(0)} ms):`,
      error.message,
    );
    throw error;
  }
  console.info(
    `[Supabase] Fetched ${rows.length} car parks (started ${startedAt.toISOString()}, completed ${new Date().toISOString()}, elapsed ${(performance.now() - started).toFixed(0)} ms).`,
  );
  return rows.map((row) => {
    const percentFull = row.total_spots > 0 && row.occupied != null
      ? Math.min(Math.round((row.occupied / row.total_spots) * 100), 100)
      : null;
    return {
      id: String(row.facility_id),
      name: cleanFacilityName(row.facility_name),
      tfnswId: row.facility_id,
      suburb: row.suburb,
      address: row.address,
      spots: row.total_spots,
      occupied: row.occupied,
      available: row.available,
      percentFull,
      updated: row.message_date ?? row.updated_at,
    };
  });
}

let syncInProgress;
let lastSyncStartedAt = 0;
let rateLimitUntil = 0;
let rateLimitCount = 0;

function updateRateLimitBackoff(error) {
  if (error.status !== 429) return;
  rateLimitCount += 1;
  const exponentialBackoff = Math.min(
    initialRateLimitBackoffMilliseconds * (2 ** (rateLimitCount - 1)),
    maximumRateLimitBackoffMilliseconds,
  );
  rateLimitUntil = Date.now() + Math.max(error.retryAfterMilliseconds ?? 0, exponentialBackoff);
  const retryMinutes = Math.ceil((rateLimitUntil - Date.now()) / 60_000);
  console.error(`TfNSW rate limit reached; next sync attempt in about ${retryMinutes} minute(s).`);
}

async function syncCarparks() {
  if (syncInProgress) return syncInProgress;
  if (Date.now() < rateLimitUntil) {
    const error = new Error("TfNSW rate limit backoff is active. Please try again later.");
    error.status = 429;
    error.retryAfterMilliseconds = rateLimitUntil - Date.now();
    throw error;
  }
  lastSyncStartedAt = Date.now();
  syncInProgress = (async () => {
    const facilities = await fetchRequestedFacilities();
    const url = new URL(`/rest/v1/${tableName}`, requiredEnv(SUPABASE_URL, "SUPABASE_URL"));
    url.searchParams.set("on_conflict", "id");
    const startedAt = new Date();
    const started = performance.now();
    try {
      await requestJson(url, {
        method: "POST",
        headers: supabaseHeaders({
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify(facilities),
      }, "Supabase");
    } catch (error) {
      console.error(
        `[Supabase] Upsert failed for ${facilities.length} car parks (started ${startedAt.toISOString()}, elapsed ${(performance.now() - started).toFixed(0)} ms):`,
        error.message,
      );
      throw error;
    }
    console.info(
      `[Supabase] Upsert successful for ${facilities.length} car parks (facility IDs: ${facilities.map(({ facility_id }) => facility_id).join(", ")}; started ${startedAt.toISOString()}, completed ${new Date().toISOString()}, elapsed ${(performance.now() - started).toFixed(0)} ms).`,
    );
    rateLimitCount = 0;
    rateLimitUntil = 0;
    return facilities.length;
  })().catch((error) => {
    updateRateLimitBackoff(error);
    throw error;
  });
  try {
    return await syncInProgress;
  } finally {
    syncInProgress = undefined;
  }
}

async function runScheduledSync() {
  const nextDelay = scheduledSyncDelayMilliseconds();
  try {
    const count = await syncCarparks();
    console.log(`Synced ${count} car parks to Supabase.`);
  } catch (error) {
    console.error("Scheduled car park sync failed:", error.message);
  }
  const backoffRemaining = Math.max(rateLimitUntil - Date.now(), 0);
  setTimeout(runScheduledSync, Math.max(nextDelay, backoffRemaining));
}

function carparksResponse(carparks) {
  return {
    source: "supabase",
    fetchedAt: new Date().toISOString(),
    carparks,
  };
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/carparks") {
    try {
      return sendJson(res, 200, carparksResponse(await fetchCarparksFromSupabase()));
    } catch (error) {
      console.error("Unable to load car parks from Supabase:", error.message);
      return sendJson(res, error.status === 401 || error.status === 403 ? 502 : error.status || 500, {
        error: error.message,
      });
    }
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/carparks/sync") {
    if (Date.now() < rateLimitUntil) {
      const retryAfterSeconds = Math.ceil((rateLimitUntil - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfterSeconds);
      return sendJson(res, 429, { error: "TfNSW rate limit backoff is active. Please try again later." });
    }
    const cooldownRemaining = manualSyncCooldownMilliseconds - (Date.now() - lastSyncStartedAt);
    if (cooldownRemaining > 0) {
      res.setHeader("Retry-After", Math.ceil(cooldownRemaining / 1000));
      return sendJson(res, 429, { error: "A car park sync ran recently. Please try again shortly." });
    }
    try {
      const count = await syncCarparks();
      console.log(`Manually synced ${count} car parks to Supabase.`);
      return sendJson(res, 200, carparksResponse(await fetchCarparksFromSupabase()));
    } catch (error) {
      console.error("Unable to sync car parks:", error.message);
      return sendJson(res, error.status === 401 || error.status === 403 ? 502 : error.status || 500, {
        error: error.message,
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
    if (pathname.startsWith("/vendor/")) return res.writeHead(404).end("Not found");
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
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (res.headersSent) return res.destroy(error);
    sendJson(res, 500, { error: "Internal server error" });
  });
});

server.listen(PORT, () => {
  console.log(`TMark NSW Transport server on http://localhost:${PORT}`);
  const missingConfig = [];
  if (!TFNSW_API_KEY) missingConfig.push("TFNSW_API_KEY");
  if (!supabaseKey) missingConfig.push("SUPABASE_SECRET_KEY");
  if (missingConfig.length) {
    console.error(`Car park sync worker disabled; configure ${missingConfig.join(" and ")} in backend/.env.`);
  } else {
    void runScheduledSync();
  }
});
