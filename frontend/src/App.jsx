import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const columns = [
  { key: "name", label: "Car park" },
  { key: "spots", label: "Capacity", numeric: true },
  { key: "occupied", label: "Occupied", numeric: true },
  { key: "available", label: "Available", numeric: true },
  { key: "percentFull", label: "Free %", numeric: true },
  { key: "updated", label: "Data time" },
];

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "-"
    : new Intl.DateTimeFormat("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: "Australia/Sydney",
    }).format(date);
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
  const location = [park.address, park.suburb].filter(Boolean).join(", ");

  return (
    <tr>
      {columns.map(({ key, numeric }) => {
        const value = park[key];
        const classNames = [];
        if (numeric) classNames.push("num");
        if (key === "updated") classNames.push("muted");

        if (key === "name") {
          return (
            <td key={key}>
              <span className="name">{value ?? "-"}</span>
              {location && <span className="muted location">{location}</span>}
            </td>
          );
        }

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
  const [selectedSuburbs, setSelectedSuburbs] = useState(null);
  const [draftSuburbs, setDraftSuburbs] = useState(null);
  const [isSuburbMenuOpen, setIsSuburbMenuOpen] = useState(false);
  const [sortKey, setSortKey] = useState("name");
  const [sortDirection, setSortDirection] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState("");
  const [fetchedAt, setFetchedAt] = useState(null);
  const suburbTriggerRef = useRef(null);
  const firstSuburbOptionRef = useRef(null);

  const loadCarparks = useCallback(async (sync = false) => {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(sync ? "/api/carparks/sync" : "/api/carparks", {
        method: sync ? "POST" : "GET",
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

  useEffect(() => {
    if (!isSuburbMenuOpen) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setIsSuburbMenuOpen(false);
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstSuburbOptionRef.current?.focus();
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      suburbTriggerRef.current?.focus();
    };
  }, [isSuburbMenuOpen]);

  const suburbs = useMemo(
    () => [...new Set(carparks.map((park) => park.suburb?.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)),
    [carparks],
  );
  const suburbFilteredCarparks = useMemo(
    () => selectedSuburbs === null
      ? carparks
      : carparks.filter((park) => selectedSuburbs.includes(park.suburb?.trim())),
    [carparks, selectedSuburbs],
  );

  const matches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return suburbFilteredCarparks
      .filter((park) =>
        `${park.name} ${park.id} ${park.tfnswId ?? ""} ${park.suburb ?? ""} ${park.address ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery),
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
  }, [suburbFilteredCarparks, query, sortDirection, sortKey]);

  function handleSort(key) {
    if (key === sortKey) {
      setSortDirection((direction) => direction * -1);
    } else {
      setSortKey(key);
      setSortDirection(1);
    }
  }

  const selectedSuburbCount = selectedSuburbs === null ? suburbs.length : selectedSuburbs.length;
  const draftSuburbCount = draftSuburbs === null ? suburbs.length : draftSuburbs.length;

  return (
    <main className="page">
      <header className="head">
        <div>
          <h1>Car park availability</h1>
          <p className="sub">Live car park occupancy from Transport for NSW</p>
        </div>
      </header>
      <div className="tools">
        <input
          type="search"
          placeholder="Search by name, location, or facility ID"
          aria-label="Search car parks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" onClick={() => loadCarparks(true)} disabled={isLoading}>
          {isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <div className="station-toolbar">
        <button
          ref={suburbTriggerRef}
          className="suburb-trigger"
          type="button"
          aria-expanded={isSuburbMenuOpen}
          aria-controls="suburb-dialog"
          onClick={() => {
            setDraftSuburbs(selectedSuburbs);
            setIsSuburbMenuOpen(true);
          }}
        >
          <span className="suburb-icon" aria-hidden="true">⌖</span>
          <span>Suburbs</span>
          <span className="suburb-count">
            {selectedSuburbs === null ? "All" : `${selectedSuburbCount}/${suburbs.length}`}
          </span>
          <span className={`suburb-chevron${isSuburbMenuOpen ? " is-open" : ""}`} aria-hidden="true">⌄</span>
        </button>
        <span className="suburb-hint">
          {selectedSuburbs === null ? "Showing all suburbs" : `Showing ${selectedSuburbCount} selected`}
        </span>
      </div>
      {isSuburbMenuOpen && (
        <div
          className="suburb-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setDraftSuburbs(selectedSuburbs);
              setIsSuburbMenuOpen(false);
            }
          }}
        >
          <section
            className="suburb-menu"
            id="suburb-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="suburb-dialog-title"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusableItems = event.currentTarget.querySelectorAll("button:not(:disabled), input:not(:disabled)");
              const firstItem = focusableItems[0];
              const lastItem = focusableItems[focusableItems.length - 1];
              if (event.shiftKey && document.activeElement === firstItem) {
                event.preventDefault();
                lastItem?.focus();
              } else if (!event.shiftKey && document.activeElement === lastItem) {
                event.preventDefault();
                firstItem?.focus();
              }
            }}
          >
            <div className="suburb-menu-heading">
              <div>
                <span className="suburb-dialog-eyebrow">CAR PARK FILTER</span>
                <h2 id="suburb-dialog-title">Select suburbs</h2>
                <p>{draftSuburbCount} of {suburbs.length} suburbs selected</p>
              </div>
              <button
                className="suburb-close"
                type="button"
                aria-label="Close suburb selector"
                onClick={() => {
                  setDraftSuburbs(selectedSuburbs);
                  setIsSuburbMenuOpen(false);
                }}
              >
                ×
              </button>
            </div>
            <div className="suburb-menu-actions">
              <span>Choose the areas to include in your car park results.</span>
              <div>
                <button type="button" onClick={() => setDraftSuburbs(null)}>Select all</button>
                <button type="button" onClick={() => setDraftSuburbs([])}>Clear</button>
              </div>
            </div>
            <div className="suburb-options" role="group" aria-label="Available suburbs">
              {suburbs.length ? suburbs.map((suburb, index) => {
                const isSelected = draftSuburbs === null || draftSuburbs.includes(suburb);
                return (
                  <label className="suburb-option" key={suburb}>
                    <input
                      ref={index === 0 ? firstSuburbOptionRef : undefined}
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        const currentSelection = draftSuburbs ?? suburbs;
                        const nextSelection = isSelected
                          ? currentSelection.filter((item) => item !== suburb)
                          : [...currentSelection, suburb];
                        setDraftSuburbs(nextSelection.length === suburbs.length ? null : nextSelection);
                      }}
                    />
                    <span>{suburb}</span>
                  </label>
                );
              }) : <p className="suburb-empty">No suburbs available</p>}
            </div>
            <div className="suburb-menu-footer">
              <button
                className="suburb-cancel"
                type="button"
                onClick={() => {
                  setDraftSuburbs(selectedSuburbs);
                  setIsSuburbMenuOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                className="suburb-save"
                type="button"
                onClick={() => {
                  setSelectedSuburbs(draftSuburbs);
                  setIsSuburbMenuOpen(false);
                }}
              >
                Save selection
              </button>
            </div>
          </section>
        </div>
      )}
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
                  {selectedSuburbs !== null && selectedSuburbCount === 0
                    ? "Select at least one suburb to view car parks"
                    : isLoading && !hasLoaded
                      ? "Loading car park data..."
                      : suburbFilteredCarparks.length
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
        {fetchedAt ? ` · Checked ${formatDate(fetchedAt)}` : ""}
      </footer>
    </main>
  );
}
