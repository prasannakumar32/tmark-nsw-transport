import { useCallback, useEffect, useMemo, useState } from "react";

const columns = [
  { key: "name", label: "Car park" },
  { key: "spots", label: "Capacity", numeric: true },
  { key: "occupied", label: "Occupied", numeric: true },
  { key: "available", label: "Available", numeric: true },
  { key: "percentFull", label: "Free %", numeric: true },
  { key: "updated", label: "Updated" },
];

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}

function getSortValue(park, key) {
  const value = park[key];
  if (value == null) return null;
  if (key === "percentFull") {
    const percentFull = Number(value);
    return Number.isFinite(percentFull) ? 100 - percentFull : null;
  }
  if (key === "updated") {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return typeof value === "number" ? value : String(value);
}

function SortableHeader({ column, sortKey, sortDirection, onSort }) {
  const isSorted = column.key === sortKey;
  const direction = sortDirection === 1 ? "ascending" : "descending";
  const indicator = isSorted ? (sortDirection === 1 ? "↑" : "↓") : "";

  return (
    <th className={column.numeric ? "num" : undefined} aria-sort={isSorted ? direction : "none"}>
      <button
        className="sort-button"
        type="button"
        aria-label={`Sort by ${column.label}${isSorted ? `, ${direction}` : ""}`}
        onClick={() => onSort(column.key)}
      >
        {column.label}
        <span className="sort-indicator" aria-hidden="true">{indicator}</span>
      </button>
    </th>
  );
}

function CarParkRow({ park }) {
  return (
    <tr>
      {columns.map(({ key, numeric }) => {
        const value = park[key];
        const classNames = [];
        if (numeric) classNames.push("num");
        if (key === "name") classNames.push("name");
        if (key === "updated") classNames.push("muted");

        if (key === "percentFull") {
          const freePercent = value == null ? null : 100 - Number(value);
          if (freePercent != null && Number.isFinite(freePercent)) {
            classNames.push("free-percent", freePercent === 0 ? "full" : freePercent <= 25 ? "busy" : "open");
          }
          return (
            <td key={key} className={classNames.join(" ")}>
              {freePercent == null || !Number.isFinite(freePercent)
                ? "-"
                : `${freePercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}
            </td>
          );
        }

        if (key === "available") {
          classNames.push("avail", value === 0 ? "full" : park.percentFull >= 75 ? "busy" : "open");
        }

        let displayValue = value == null ? "-" : value;
        if (key === "updated") displayValue = formatDate(value);
        else if (key !== "name" && value != null) displayValue = Number(value).toLocaleString();

        return <td key={key} className={classNames.join(" ")}>{displayValue}</td>;
      })}
    </tr>
  );
}

export default function App() {
  const [carparks, setCarparks] = useState([]);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState("name");
  const [sortDirection, setSortDirection] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState("");
  const [fetchedAt, setFetchedAt] = useState(null);

  const loadCarparks = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch("/api/carparks", {
        headers: { Accept: "application/json" },
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      setCarparks(Array.isArray(payload.carparks) ? payload.carparks : []);
      setFetchedAt(payload.fetchedAt);
      setHasLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load car park data.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCarparks();
    const intervalId = window.setInterval(loadCarparks, 300000);
    return () => window.clearInterval(intervalId);
  }, [loadCarparks]);

  const matches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return carparks
      .filter((park) =>
        `${park.name} ${park.id} ${park.tfnswId ?? ""}`.toLowerCase().includes(normalizedQuery),
      )
      .sort((a, b) => {
        const left = getSortValue(a, sortKey);
        const right = getSortValue(b, sortKey);
        if (left == null || right == null) {
          return left == null ? (right == null ? 0 : 1) : -1;
        }
        const comparison = typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right)
          : left - right;
        return comparison * sortDirection;
      });
  }, [carparks, query, sortDirection, sortKey]);

  function handleSort(key) {
    if (key === sortKey) {
      setSortDirection((direction) => direction * -1);
    } else {
      setSortKey(key);
      setSortDirection(1);
    }
  }

  const availableSpaces = carparks.reduce((sum, park) => sum + (park.available ?? 0), 0);
  const fullCarparks = carparks.filter((park) => park.available === 0).length;

  return (
    <main className="page">
      <header className="head">
        <div>
          <h1>Car park availability</h1>
          <p className="sub">Live car park occupancy from Transport for NSW</p>
        </div>
        <div className="summary" aria-label="Summary">
          <div><strong>{hasLoaded ? carparks.length.toLocaleString() : "-"}</strong><span>car parks</span></div>
          <div><strong>{hasLoaded ? availableSpaces.toLocaleString() : "-"}</strong><span>spaces free</span></div>
          <div><strong>{hasLoaded ? fullCarparks.toLocaleString() : "-"}</strong><span>full</span></div>
        </div>
      </header>
      <div className="tools">
        <input
          type="search"
          placeholder="Search by name or facility ID"
          aria-label="Search car parks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" onClick={loadCarparks} disabled={isLoading}>
          {isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <SortableHeader
                  key={column.key}
                  column={column}
                  sortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {matches.map((park) => <CarParkRow key={park.id} park={park} />)}
            {!matches.length && (
              <tr>
                <td className="empty" colSpan={columns.length}>
                  {isLoading && !hasLoaded
                    ? "Loading car park data..."
                    : carparks.length
                      ? "No matching car parks"
                      : "No car park data available"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="foot">
        Data © Transport for NSW (CC BY)
        {fetchedAt ? ` · Updated ${formatDate(fetchedAt)}` : ""}
      </footer>
    </main>
  );
}
