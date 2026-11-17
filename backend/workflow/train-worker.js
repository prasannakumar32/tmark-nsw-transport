import fs from "node:fs";
import path from "node:path";
import { backendDir, requiredEnv, supabaseKey } from "../shared/env.js";
import { requestJson, syncDepartures } from "../shared/supabase.js";
import { cleanTfnswApiKey, isTfnswTrain } from "../shared/tfnsw.js";

const {
  TFNSW_API_KEY,
  TFNSW_BASE_URL = "https://api.transport.nsw.gov.au/v1",
} = process.env;

const configPath = path.join(backendDir, "workflow", "train-config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!config || typeof config.timeZone !== "string" || !config.timeZone
  || !Array.isArray(config.stations) || config.stations.length === 0
  || !Array.isArray(config.windows) || config.windows.length === 0) {
  throw new Error(`Invalid train worker configuration in ${configPath}.`);
}

const stationIds = new Set();
for (const station of config.stations) {
  if (!station || !/^\d+$/.test(String(station.stopId)) || typeof station.name !== "string"
    || !station.name.trim() || stationIds.has(String(station.stopId))) {
    throw new Error(`Invalid or duplicate station in ${configPath}.`);
  }
  stationIds.add(String(station.stopId));
}

let previousWindowEnd = 0;
const adaptiveDelayWindows = config.windows.map((window) => {
  const { startHour, endHour, delaySeconds } = window;
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)
    || startHour !== previousWindowEnd || endHour <= startHour || endHour > 24
    || !Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    throw new Error(`Invalid or incomplete train delay window in ${configPath}.`);
  }
  previousWindowEnd = endHour;
  return { startHour, endHour, delayMilliseconds: delaySeconds * 1000 };
});
if (previousWindowEnd !== 24) {
  throw new Error(`Train delay windows must cover all 24 hours in ${configPath}.`);
}

const sydneyDateTimeFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: config.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const sydneyHourFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: config.timeZone,
  hour: "numeric",
  hourCycle: "h23",
});

function scheduledSyncDelayMilliseconds(timestamp = Date.now()) {
  const hourPart = sydneyHourFormat.formatToParts(new Date(timestamp))
    .find((part) => part.type === "hour");
  const hour = Number(hourPart?.value);
  if (!Number.isInteger(hour)) throw new Error("Unable to determine the configured timezone hour.");
  const window = adaptiveDelayWindows.find(({ startHour, endHour }) => hour >= startHour && hour < endHour);
  if (!window) throw new Error(`No train sync delay configured for hour ${hour}.`);
  return window.delayMilliseconds;
}

function localDateAndTime(timestamp) {
  const parts = Object.fromEntries(
    sydneyDateTimeFormat.formatToParts(new Date(timestamp))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    time: `${parts.hour}${parts.minute}`,
  };
}

function asIsoTimestamp(value, label, stopId) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = /^\d{9,10}$/.test(String(value))
    ? Number(value) * 1000
    : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`TfNSW returned an invalid ${label} for stop ${stopId}.`);
  }
  return new Date(parsed).toISOString();
}

function propertyValue(properties, name) {
  if (!properties || typeof properties !== "object") return null;
  const value = Array.isArray(properties)
    ? properties.find(
        (item) => String(item?.key ?? item?.name ?? "").toLowerCase() === name,
      )?.value
    : properties[name] ?? Object.entries(properties)
      .find(([key]) => key.toLowerCase() === name)?.[1];
  return value == null ? null : String(value);
}

function platformNumber(value) {
  const match = String(value ?? "").match(/(\d+)\D*$/);
  return match?.[1] ?? null;
}

function stopEventsFrom(payload, station) {
  if (Array.isArray(payload?.stopEvents)) return payload.stopEvents;
  if (Array.isArray(payload?.locations)) {
    const locationsWithEvents = payload.locations
      .filter((location) => Array.isArray(location?.stopEvents));
    const matchingLocation = locationsWithEvents.find((location) => {
      const locationStopId = location.id
        ?? location.stopId
        ?? propertyValue(location.properties, "stopid")
        ?? propertyValue(location.properties, "stop_id");
      return locationStopId != null && String(locationStopId) === String(station.stopId);
    });
    const location = matchingLocation
      ?? (locationsWithEvents.length === 1 ? locationsWithEvents[0] : null);
    if (location) return location.stopEvents;
  }

  const responseKeys = payload && typeof payload === "object" && !Array.isArray(payload)
    ? Object.keys(payload).join(", ")
    : typeof payload;
  throw new Error(
    `TfNSW returned no departure events for stop ${station.stopId} (response keys: ${responseKeys || "none"}).`,
  );
}

function formatDepartures(payload, station, updatedAt) {
  const stopEvents = stopEventsFrom(payload, station)
    .filter((event) => isTfnswTrain(event?.transportation));
  return stopEvents.map((event, index) => {
    const transportation = event?.transportation;
    const plannedDeparture = asIsoTimestamp(
      event?.departureTimePlanned,
      "planned departure time",
      station.stopId,
    );
    if (!plannedDeparture || !transportation || typeof transportation !== "object") {
      throw new Error(`TfNSW returned an incomplete departure at stop ${station.stopId} (item ${index}).`);
    }

    const estimatedDeparture = asIsoTimestamp(
      event.departureTimeEstimated ?? event.departureTimePlanned,
      "estimated departure time",
      station.stopId,
    );
    const isCancelled = event.isCancelled === true || event.cancelled === true;
    const delayMilliseconds = Date.parse(estimatedDeparture) - Date.parse(plannedDeparture);
    const delayMinutes = Math.round(delayMilliseconds / 60_000);
    const status = isCancelled
      ? "Cancelled"
      : delayMinutes > 0
        ? `LATE ${delayMinutes} min`
        : delayMinutes < 0
          ? `EARLY ${Math.abs(delayMinutes)} min`
          : "ON TIME";
    const line = transportation.disassembledName
      || transportation.number
      || String(transportation.name ?? "").match(/\b[A-Z]\d{1,2}\b/)?.[0]
      || "";
    const destination = transportation.destination?.name
      ?? transportation.destination
      ?? "";
    const platform = propertyValue(event.location?.properties, "platform")
      ?? propertyValue(event.properties, "platform");
    const destinationName = String(destination).slice(0, 200);
    const lineName = String(line).trim().slice(0, 100);
    const platformName = platformNumber(platform);
    const speechText = `${lineName ? `${lineName} ` : ""}train to ${destinationName || "its destination"}, ${status.toLowerCase()}${platformName ? `, platform ${platformName}` : ""}.`;

    return {
      UpdatedAt: updatedAt,
      Line: lineName || null,
      Destination: destinationName || null,
      Status: status,
      Platform: platformName,
      Station: station.name.slice(0, 120),
      SpeechText: speechText.slice(0, 2000),
      ScheduledDateTime: plannedDeparture,
      EstimatedDateTime: estimatedDeparture,
      StopID: station.stopId,
    };
  }).filter(({ EstimatedDateTime }) => Date.parse(EstimatedDateTime) >= Date.parse(updatedAt));
}

async function fetchDepartures(station) {
  const apiKey = cleanTfnswApiKey(TFNSW_API_KEY);
  const { date, time } = localDateAndTime(Date.now());
  const url = new URL(`${TFNSW_BASE_URL.replace(/\/+$/, "")}/tp/departure_mon`);
  for (const [key, value] of Object.entries({
    outputFormat: "rapidJSON",
    coordOutputFormat: "EPSG:4326",
    mode: "direct",
    itdDateTimeDepArr: "dep",
    itdDate: date,
    itdTime: time,
    type_dm: "stop",
    name_dm: station.stopId,
    departureMonitorMacro: "true",
    TfNSWDM: "true",
    useRealtime: "1",
    version: "10.2.1.42",
  })) {
    url.searchParams.set(key, value);
  }
  return requestJson(url, {
    headers: { Authorization: `apikey ${apiKey}`, Accept: "application/json" },
  }, "Transport NSW");
}

let rateLimitUntil = 0;
let rateLimitCount = 0;
function updateRateLimitBackoff(error) {
  if (error.status !== 429) return;
  rateLimitCount += 1;
  const exponentialBackoff = Math.min(5 * 60_000 * (2 ** (rateLimitCount - 1)), 6 * 60 * 60_000);
  rateLimitUntil = Date.now() + Math.max(error.retryAfterMilliseconds ?? 0, exponentialBackoff);
}

async function syncStations() {
  for (const station of config.stations) {
    if (Date.now() < rateLimitUntil) break;
    const scannedAt = new Date().toISOString();
    try {
      const payload = await fetchDepartures(station);
      const departures = formatDepartures(payload, station, scannedAt);
      await syncDepartures(station.stopId, scannedAt, departures);
      rateLimitCount = 0;
      rateLimitUntil = 0;
      console.info(`[Train worker] Synced ${departures.length} departures for ${station.name}.`);
    } catch (error) {
      updateRateLimitBackoff(error);
      console.error(`[Train worker] Sync failed for ${station.name}:`, error.message);
      if (error.status === 429) break;
    }
  }
}

async function runScheduledSync() {
  let nextDelay;
  try {
    nextDelay = scheduledSyncDelayMilliseconds();
  } catch (error) {
    console.error("[Train worker] Unable to calculate the next sync interval:", error.message);
    nextDelay = 60_000;
  }

  console.info(`[Train worker] Starting sync at ${new Date().toISOString()}.`);
  await syncStations();
  const delay = Math.max(nextDelay, rateLimitUntil - Date.now(), 0);
  console.info(`[Train worker] Next sync scheduled in ${Math.ceil(delay / 1000)} seconds.`);
  setTimeout(runScheduledSync, delay);
}

requiredEnv(TFNSW_API_KEY, "TFNSW_API_KEY");
requiredEnv(supabaseKey, "SUPABASE_SECRET_KEY");
console.info("[Train worker] TfNSW train departure sync worker started.");
void runScheduledSync();
