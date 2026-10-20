/**
 * The two faces of Play. Battles used to be its own tab, which made the bottom
 * bar six items wide and pushed Create off centre; they are one destination, so
 * this control is how you move between them.
 */
export function PlaySegments({
  active,
  onChange,
}: {
  active: "games" | "battles";
  onChange: (segment: "games" | "battles") => void;
}) {
  return (
    <div className="play-segments" role="tablist" aria-label="Play sections">
      <button
        type="button"
        role="tab"
        aria-selected={active === "games"}
        className={`play-segment${active === "games" ? " active" : ""}`}
        onClick={() => onChange("games")}
      >
        Games
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "battles"}
        className={`play-segment${active === "battles" ? " active" : ""}`}
        onClick={() => onChange("battles")}
      >
        Battles
      </button>
    </div>
  );
}
