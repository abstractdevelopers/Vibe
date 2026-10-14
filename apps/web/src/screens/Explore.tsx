import { useState } from "react";
import { CompassIcon } from "../components/Icons";

const FILTERS = ["Trending", "Communities", "Activities", "Events", "Places", "Creators", "Shops"];

export function ExploreScreen() {
  const [filter, setFilter] = useState("Trending");

  return (
    <div>
      <h1 className="screen-title">Explore</h1>

      <input
        aria-label="Search Vibe"
        placeholder="Search people, activities, events, places…"
        style={{ marginBottom: "var(--space-3)" }}
      />

      <div className="pill-row" role="tablist" aria-label="Explore categories">
        {FILTERS.map((f) => (
          <button key={f} className="pill" role="tab" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>

      <div className="empty">
        <CompassIcon width={40} height={40} />
        <h3 className="section-title">{filter} lands in a later phase</h3>
        <p className="muted" style={{ maxWidth: "36ch" }}>
          Explore works without location permission, and nothing here is fabricated.
          When it fills up, sponsored placements will be labelled and real counts shown.
        </p>
      </div>
    </div>
  );
}
