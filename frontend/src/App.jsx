import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const suburbSelectionStorageKey = "tmark-nsw-transport:selected-suburbs";

function readStoredSuburbSelection() {
  try {
    const storedSelection = window.localStorage.getItem(suburbSelectionStorageKey);
    if (storedSelection === null) return { selectedSuburbs: null, error: "" };

    const selectedSuburbs = JSON.parse(storedSelection);
    if (selectedSuburbs === null
      || (Array.isArray(selectedSuburbs) && selectedSuburbs.every((suburb) => typeof suburb === "string"))) {
      return { selectedSuburbs, error: "" };
    }

    return {
      selectedSuburbs: null,
      error: "The saved suburb selection is invalid. Choose your suburbs again.",
    };
  } catch (storageError) {
    console.error("Unable to restore the saved suburb selection:", storageError);
    return {
      selectedSuburbs: null,
      error: "Unable to restore the saved suburb selection from this browser.",
    };
  }
}

function formatFetchTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    timeZone: "Australia/Sydney",
  }).format(date);
}

function CarParkRow({ park }) {
  const suburb = park.suburb?.trim();
  const totalSpots = Number(park.spots);
  const availableSpots = Number(park.available);
  const hasCapacity = park.spots != null && Number.isFinite(totalSpots) && totalSpots > 0;
  const hasAvailability = hasCapacity && park.available != null && Number.isFinite(availableSpots);
  const freeSpots = hasAvailability ? Math.min(Math.max(availableSpots, 0), totalSpots) : 0;
  const occupiedValue = Number(park.occupied);
  const occupiedSpots = hasCapacity
    ? park.occupied != null && Number.isFinite(occupiedValue)
      ? Math.min(Math.max(occupiedValue, 0), totalSpots)
      : hasAvailability ? totalSpots - freeSpots : null
    : null;
  const freePercent = hasCapacity ? (freeSpots / totalSpots) * 100 : 0;
  const availabilityStatus = !hasAvailability
    ? "unknown"
    : freePercent > 40 ? "good" : freePercent < 20 ? "critical" : "low";

  return (
    <tr className={`availability-${availabilityStatus}`}>
      <td>
        <span className="name">{suburb || "-"}</span>
        {park.address && <span className="muted location">{park.address}</span>}
      </td>
      <td className="num">{hasCapacity ? totalSpots.toLocaleString() : "-"}</td>
      <td className="num">{occupiedSpots == null ? "-" : occupiedSpots.toLocaleString()}</td>
      <td className="num available-value">
        {hasAvailability ? freeSpots.toLocaleString() : "-"}
      </td>
      <td className="availability-cell">
        {hasAvailability ? (
          <div
            className="availability-bar"
            role="img"
            aria-label={`${freeSpots.toLocaleString()} of ${totalSpots.toLocaleString()} spots available`}
          >
            <span className="availability-free" style={{ width: `${freePercent}%` }} />
            <span className="availability-occupied" style={{ width: `${100 - freePercent}%` }} />
          </div>
        ) : <div className="availability-bar availability-unknown" aria-hidden="true" />}
        <span className="availability-percent">
          {hasAvailability ? `${Math.round(freePercent)}%` : "-"}
        </span>
      </td>
    </tr>
  );
}

function DashboardHeader({ activePage }) {
  const subtitle = activePage === "car-park"
    ? "Live car park availability to help you plan your journey."
    : activePage === "train"
      ? "Train"
      : "Fuel Spot";

  return (
    <header className="head">
      <div className="page-heading">
        <h1>Commuter Dashboard</h1>
        <p className="sub">{subtitle}</p>
      </div>
      <nav className="dashboard-nav" aria-label="Commuter services">
        <a
          className={`dashboard-nav-item${activePage === "car-park" ? " is-active" : ""}`}
          href="/"
          aria-current={activePage === "car-park" ? "page" : undefined}
        >
          <i className="fa-solid fa-square-parking" aria-hidden="true" />
          <span>Car Park</span>
        </a>
        <a
          className={`dashboard-nav-item${activePage === "train" ? " is-active" : ""}`}
          href="/train"
          aria-current={activePage === "train" ? "page" : undefined}
        >
          <i className="fa-solid fa-train" aria-hidden="true" />
          <span>Train</span>
        </a>
        <a
          className={`dashboard-nav-item${activePage === "fuel-spot" ? " is-active" : ""}`}
          href="/fuel-spot"
          aria-current={activePage === "fuel-spot" ? "page" : undefined}
        >
          <i className="fa-solid fa-gas-pump" aria-hidden="true" />
          <span>Fuel Spot</span>
        </a>
      </nav>
    </header>
  );
}

function EmptyServicePage({ activePage }) {
  return (
    <main className="page">
      <DashboardHeader activePage={activePage} />
    </main>
  );
}

function CarParkPage() {
  const [initialSuburbSelection] = useState(readStoredSuburbSelection);
  const [carparks, setCarparks] = useState([]);
  const [selectedSuburbs, setSelectedSuburbs] = useState(initialSuburbSelection.selectedSuburbs);
  const [draftSuburbs, setDraftSuburbs] = useState(null);
  const [isSuburbMenuOpen, setIsSuburbMenuOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState("");
  const [suburbStorageError, setSuburbStorageError] = useState(initialSuburbSelection.error);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [isDisclaimerOpen, setIsDisclaimerOpen] = useState(false);
  const suburbTriggerRef = useRef(null);
  const firstSuburbOptionRef = useRef(null);
  const disclaimerTriggerRef = useRef(null);

  const loadCarparks = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`${process.env.API_BASE_URL}/api/carparks`, {
        headers: { Accept: "application/json" },
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      setCarparks(Array.isArray(payload.carparks) ? payload.carparks : []);
      setFetchedAt(payload.fetchedAt ?? null);
      setHasLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load car park data.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCarparks();
    const intervalId = window.setInterval(loadCarparks, 12000);
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

  useEffect(() => {
    if (!isDisclaimerOpen) return undefined;

    function handleDismiss(event) {
      if (event.type === "keydown" && event.key === "Escape") {
        setIsDisclaimerOpen(false);
        disclaimerTriggerRef.current?.focus();
      } else if (
        event.type === "pointerdown"
        && !disclaimerTriggerRef.current?.contains(event.target)
      ) {
        setIsDisclaimerOpen(false);
      }
    }

    document.addEventListener("keydown", handleDismiss);
    document.addEventListener("pointerdown", handleDismiss);
    return () => {
      document.removeEventListener("keydown", handleDismiss);
      document.removeEventListener("pointerdown", handleDismiss);
    };
  }, [isDisclaimerOpen]);

  const suburbs = useMemo(
    () => [...new Set(carparks.map((park) => park.suburb?.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)),
    [carparks],
  );
  const matches = useMemo(
    () => [...(selectedSuburbs === null
      ? carparks
      : carparks.filter((park) => selectedSuburbs.includes(park.suburb?.trim())))]
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))),
    [carparks, selectedSuburbs],
  );

  const selectedSuburbCount = selectedSuburbs === null ? suburbs.length : selectedSuburbs.length;
  const draftSuburbCount = draftSuburbs === null ? suburbs.length : draftSuburbs.length;
  const formattedFetchTime = formatFetchTime(fetchedAt);

  return (
    <main className="page">
      <DashboardHeader activePage="car-park" />
      <p
        className="last-updated"
        aria-live="polite"
        aria-label={formattedFetchTime ? `Last updated ${formattedFetchTime}` : "Last updated time unavailable"}
      >
        Last updated: {formattedFetchTime || "—"}
      </p>
      <div className="station-toolbar" id="car-park">
        <div className="filter-copy">
          <span className="section-eyebrow">PARKING LOCATIONS</span>
          <span className="filter-caption">Choose suburbs to narrow the results</span>
        </div>
        <div className="suburb-control">
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
          <span className="suburb-hint" aria-live="polite">
            {selectedSuburbs === null
              ? `Showing data for: ${suburbs.join(", ") || "no suburbs available"}`
              : `Showing data for: ${selectedSuburbs.join(", ")}`}
          </span>
        </div>
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
                  try {
                    window.localStorage.setItem(
                      suburbSelectionStorageKey,
                      JSON.stringify(draftSuburbs),
                    );
                    setSuburbStorageError("");
                  } catch (storageError) {
                    console.error("Unable to save the suburb selection:", storageError);
                    setSuburbStorageError(
                      "Your suburb selection was applied but could not be saved in this browser.",
                    );
                  }
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
      {suburbStorageError && <div className="error" role="alert">{suburbStorageError}</div>}
      <div className="tablewrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Suburbs</th>
                <th scope="col" className="num">Capacity</th>
                <th scope="col" className="num">Occupied</th>
                <th scope="col" className="num">Available</th>
                <th scope="col" className="availability-cell">Free %</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((park) => <CarParkRow key={park.id} park={park} />)}
              {!matches.length && (
                <tr>
                  <td className="empty" colSpan={5}>
                    {selectedSuburbs !== null && selectedSuburbCount === 0
                      ? "Select at least one suburb to view results"
                      : isLoading && !hasLoaded
                        ? "Loading suburb data..."
                        : "No suburb data available"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <footer className="page-footer">
        <div className="footer-bar">
          <span>
            Send suggestions to{" "}
            <a
              href="mailto:info@tmarkapps.com?subject=Carpark%20spots%20and%20fuel%20info"
              aria-label="Send suggestions by email to info@tmarkapps.com"
            >
              info@tmarkapps.com
            </a>
          </span>
          <span className="footer-divider" aria-hidden="true">|</span>
          <span>
            By{" "}
            <a className="footer-company-link" href="https://tmarkapps.com/">
              <strong>TMARK Techs</strong>
            </a>
          </span>
          <span className="footer-divider" aria-hidden="true">|</span>
          <button
            ref={disclaimerTriggerRef}
            className="footer-disclaimer-link"
            aria-describedby="footer-disclaimer-tooltip"
            aria-expanded={isDisclaimerOpen}
            onClick={() => setIsDisclaimerOpen((isOpen) => !isOpen)}
          >
            <span className="footer-info-badge" aria-hidden="true">i</span>
            Disclaimer
            <span className="footer-tooltip" id="footer-disclaimer-tooltip" role="tooltip">
              All data shown are based on TfNSW Open Data and may not always be accurate due to
              heavy system processing and time-sensitive information.
            </span>
          </button>
        </div>
      </footer>
    </main>
  );
}

export default function App() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/train") return <EmptyServicePage activePage="train" />;
  if (pathname === "/fuel-spot") return <EmptyServicePage activePage="fuel-spot" />;
  return <CarParkPage />;
}
