import { requiredEnv, supabaseKey, supabaseUrl } from "./env.js";

function tableUrl(tableName) {
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
    throw new Error("Invalid Supabase table name.");
  }
  return new URL(`/rest/v1/${tableName}`, requiredEnv(supabaseUrl, "SUPABASE_URL"));
}

export function supabaseHeaders(extraHeaders = {}) {
  const key = requiredEnv(supabaseKey, "SUPABASE_SECRET_KEY");
  const headers = {
    apikey: key,
    Accept: "application/json",
    ...extraHeaders,
  };
  if (!key.startsWith("sb_secret_")) {
    headers["Authorization"] = ["Bearer", key].join(" ");
  }
  return headers;
}

export async function requestJson(url, options, serviceName) {
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

export async function readCarparks() {
  const url = tableUrl("car_spots");
  url.searchParams.set(
    "select",
    "id,facility_id,facility_name,suburb,address,total_spots,occupied,available",
  );
  url.searchParams.set("order", "facility_name.asc");
  const rows = await requestJson(url, { headers: supabaseHeaders() }, "Supabase");
  if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid car park list.");
  return rows.map((row) => {
    const percentFull = row.total_spots > 0 && row.occupied != null
      ? Math.min(Math.round((row.occupied / row.total_spots) * 100), 100)
      : null;
    return {
      id: String(row.facility_id),
      name: String(row.facility_name ?? "").replace(/^\s*park\s*(?:&|and)\s*ride\s*[-–—:|,;]?\s*/i, "").trim(),
      tfnswId: row.facility_id,
      suburb: row.suburb,
      address: row.address,
      spots: row.total_spots,
      occupied: row.occupied,
      available: row.available,
      percentFull,
    };
  });
}

export async function upsertCarparks(facilities) {
  const url = tableUrl("car_spots");
  url.searchParams.set("on_conflict", "id");
  await requestJson(url, {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify(facilities),
  }, "Supabase");
}

export async function readDepartures(stopId) {
  const url = tableUrl("train_departures");
  url.searchParams.set(
    "select",
    "UpdatedAt,Line,Destination,Status,Platform,Station,SpeechText,ScheduledDateTime,EstimatedDateTime,StopID",
  );
  url.searchParams.set("StopID", `eq.${stopId}`);
  url.searchParams.set("EstimatedDateTime", `gte.${new Date().toISOString()}`);
  url.searchParams.set("order", "EstimatedDateTime.asc");
  const rows = await requestJson(url, { headers: supabaseHeaders() }, "Supabase");
  if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid train departure list.");
  return rows.flatMap((row) => {
    const plannedDeparture = timestampAsUtcIso(row.ScheduledDateTime);
    const estimatedDeparture = timestampAsUtcIso(row.EstimatedDateTime);
    if (!row.StopID || !plannedDeparture || !estimatedDeparture
      || Date.parse(estimatedDeparture) < Date.now()) {
      return [];
    }
    return [{
      id: `${row.StopID}:${row.Line ?? ""}:${plannedDeparture}`,
      stop_id: String(row.StopID),
      stop_name: row.Station ?? "",
      service_number: row.Line ?? "",
      destination: row.Destination ?? "",
      platform: row.Platform,
      planned_departure: plannedDeparture,
      estimated_departure: estimatedDeparture,
      status: row.Status ?? "Status unavailable",
      updated_at: timestampAsUtcIso(row.UpdatedAt),
      speech_text: row.SpeechText,
    }];
  });
}

export async function syncDepartures(stopId, scannedAt, departures) {
  const url = new URL("/rest/v1/rpc/sync_train_departures", requiredEnv(supabaseUrl, "SUPABASE_URL"));
  await requestJson(url, {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify({
      p_stop_id: stopId,
      p_scanned_at: scannedAt,
      p_departures: departures,
    }),
  }, "Supabase");
}

function timestampAsUtcIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = String(value).trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
  const parsed = Date.parse(hasTimezone ? timestamp : `${timestamp.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
