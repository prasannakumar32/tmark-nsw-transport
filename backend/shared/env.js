import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const backendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

export function requiredEnv(value, name) {
  if (!value) throw new Error(`${name} is not set. Add it to backend/.env.`);
  return value;
}

export const supabaseUrl = process.env.SUPABASE_URL || "https://iaqwzvnjpfdojnbrlgpz.supabase.co";
export const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
