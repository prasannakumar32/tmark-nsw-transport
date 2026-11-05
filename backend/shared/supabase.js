import { requiredEnv, supabaseKey, supabaseUrl } from "./env.js";

const tableName = "car_spots";

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
  const url = new URL(`/rest/v1/${tableName}`, requiredEnv(supabaseUrl, "SUPABASE_URL"));
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
  const url = new URL(`/rest/v1/${tableName}`, requiredEnv(supabaseUrl, "SUPABASE_URL"));
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
