import { requiredEnv } from "./env.js";

export function cleanTfnswApiKey(value) {
  return requiredEnv(value, "TFNSW_API_KEY").trim().replace(/^apikey\s+/i, "");
}

export function isTfnswTrain(transportation) {
  const product = transportation?.product;
  if (!product || typeof product !== "object") return false;

  const productClass = Number(product.class);
  return Number.isInteger(productClass) && [1, 9].includes(productClass);
}
