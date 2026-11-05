import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { backendDir, requiredEnv, supabaseKey } from "../shared/env.js";
import { requestJson, upsertCarparks } from "../shared/supabase.js";

const {
  TFNSW_API_KEY,
  TFNSW_BASE_URL = "https://api.transport.nsw.gov.au/v1",
} = process.env;

const adaptiveDelayConfigPath = path.join(backendDir, "workflow", "adaptive-delay.json");
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

const facilityIds = ["24", "26", "27", "28", "29", "30", "31"];
const fallbackRequestDelayMilliseconds = 1_000;
const initialRateLimitBackoffMilliseconds = 5 * 60_000;
const maximumRateLimitBackoffMilliseconds = 6 * 60 * 60_000;

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

let syncInProgress;
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
  syncInProgress = (async () => {
    const facilities = await fetchRequestedFacilities();
    const startedAt = new Date();
    const started = performance.now();
    try {
      await upsertCarparks(facilities);
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
  let nextDelay;
  try {
    nextDelay = scheduledSyncDelayMilliseconds();
  } catch (error) {
    console.error("Unable to calculate the next car park sync interval:", error.message);
    nextDelay = 60_000;
  }

  console.info(`Starting scheduled car park sync at ${new Date().toISOString()}.`);
  try {
    const count = await syncCarparks();
    console.log(`Synced ${count} car parks to Supabase.`);
  } catch (error) {
    console.error("Scheduled car park sync failed:", error.message);
  } finally {
    const backoffRemaining = Math.max(rateLimitUntil - Date.now(), 0);
    const delay = Math.max(nextDelay, backoffRemaining);
    console.info(`Next car park sync scheduled for ${new Date(Date.now() + delay).toISOString()}.`);
    setTimeout(runScheduledSync, delay);
  }
}

requiredEnv(TFNSW_API_KEY, "TFNSW_API_KEY");
requiredEnv(supabaseKey, "SUPABASE_SECRET_KEY");
console.info("TfNSW Car Park Occupancy Sync Worker started.");
void runScheduledSync();
