export function tfnswTimestampAsIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = String(value).trim();
  let parsed;

  if (/^\d+$/.test(timestamp)) {
    const numeric = Number(timestamp);
    if (timestamp.length === 13) {
      parsed = numeric;
    } else if (/^\d{9,10}$/.test(timestamp)) {
      const unixEpoch = numeric * 1000;
      const year2000Epoch = Date.UTC(2000, 0, 1) + unixEpoch;
      const now = Date.now();
      // Realtime values disambiguate Unix seconds from seconds since 2000 by date proximity.
      parsed = Math.abs(unixEpoch - now) <= Math.abs(year2000Epoch - now)
        ? unixEpoch
        : year2000Epoch;
    } else {
      return null;
    }
  } else {
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
    parsed = Date.parse(hasTimezone ? timestamp : `${timestamp.replace(" ", "T")}Z`);
  }

  return Number.isFinite(parsed) && Number.isFinite(new Date(parsed).getTime())
    ? new Date(parsed).toISOString()
    : null;
}
