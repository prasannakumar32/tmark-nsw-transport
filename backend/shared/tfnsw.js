import { requiredEnv } from "./env.js";

export function cleanTfnswApiKey(value) {
  return requiredEnv(value, "TFNSW_API_KEY").trim().replace(/^apikey\s+/i, "");
}
