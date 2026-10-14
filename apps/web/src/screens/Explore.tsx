import { useState } from "react";

const FILTERS = ["Trending", "Communities", "Activities", "Events", "Places", "Creators", "Shops"];

export function ExploreScreen() {
  const [filter, setFilter] = useState("Trending");
  return (
    <div>
      <h1 className="screen-title">Explore</h1>
      <input aria-label="Search" placeholder="Search people, activities, events, places…" />

      <div className="pill-row" role="tablist" aria-label="Explore categories">
        {FILTERS.map((f) => (
          <button key={f} className="pill" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>

      <div className="empty">
        <p>{filter} is coming in a later phase.</p>
        <p className="muted">
          Explore does not require location permission. Nothing here is fabricated — when this
          surface is populated, sponsored placements will be labelled and real counts shown.
        </p>
      </div>
    </div>
  );
}
