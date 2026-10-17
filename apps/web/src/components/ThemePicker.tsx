import { useMemo, useState } from "react";
import { CheckIcon } from "./Icons";
import { THEMES, getTheme } from "../themes";
import { chooseTheme, followActivity, pickedTheme, rampFor, type Theme } from "../theme-runtime";

/**
 * Theme picker.
 *
 * Vibe has a catalogue of environments — a mood for every family of game, room
 * and surface, each in four house styles, plus four signature environments
 * (Neon Arcade, Obsidian Lounge, Cyber Arena, Royal Chamber). This lets someone
 * browse them by family, preview each one as an actual environment (its
 * surfaces, its accent, its atmosphere), try it live, or let Vibe follow
 * whatever they are doing.
 *
 * Selecting is immediate and persistent: it writes the theme to localStorage and
 * applies the full surface ramp to the document root, so the whole app changes —
 * not just the accent on a button.
 */

export function ThemePicker() {
  const [selected, setSelected] = useState<string | null>(() => pickedTheme()?.id ?? null);
  const [follow, setFollow] = useState<boolean>(() => followActivity());

  const families = useMemo(() => [...new Set(THEMES.map((t) => t.family))], []);
  const styles = useMemo(() => [...new Set(THEMES.map((t) => t.style))], []);
  const [family, setFamily] = useState<string>(() => getTheme(selected)?.family ?? "cards");
  const [style, setStyle] = useState<string>(() => getTheme(selected)?.style ?? "classic");

  function choose(theme: Theme | null) {
    setSelected(theme?.id ?? null);
    chooseTheme(theme);
  }

  function toggleFollow(next: boolean) {
    setFollow(next);
    localStorage.setItem("vibe.theme.follow", next ? "1" : "0");
    if (next) {
      setSelected(null);
      chooseTheme(null);
    }
    window.dispatchEvent(new CustomEvent("vibe:theme"));
  }

  const familyThemes = THEMES.filter((t) => t.family === family && t.style === style);

  return (
    <div className="stack">
      <label className="row spread" style={{ cursor: "pointer" }}>
        <span>
          <span style={{ display: "block", fontWeight: 600 }}>Follow activity</span>
          <span className="meta">Let the environment change with the game or room you are in</span>
        </span>
        <input type="checkbox" checked={follow} onChange={(e) => toggleFollow(e.target.checked)} />
      </label>

      <div>
        <p className="eyebrow" style={{ marginBottom: "var(--space-2)" }}>Signature environments</p>
        <div className="env-feature-grid">
          {THEMES.filter((t) => t.family === "signature").map((t) => (
            <EnvironmentTile key={t.id} theme={t} active={selected === t.id} onPick={() => choose(t)} featured />
          ))}
        </div>
      </div>

      <div className="pill-row" role="tablist" aria-label="Theme family">
        <button className="pill" aria-pressed={!selected && !follow} onClick={() => choose(null)}>Vibe default</button>
        {families.filter((f) => f !== "signature").map((f) => (
          <button key={f} className="pill" aria-pressed={family === f && !follow} onClick={() => setFamily(f)}>
            {f}
          </button>
        ))}
      </div>

      <div className="pill-row" role="tablist" aria-label="Theme style">
        {styles.map((s) => (
          <button key={s} className="pill" aria-pressed={style === s} onClick={() => setStyle(s)}>{s}</button>
        ))}
      </div>

      <div className="theme-grid">
        {familyThemes.map((t) => (
          <EnvironmentTile key={t.id} theme={t} active={selected === t.id} onPick={() => choose(t)} />
        ))}
      </div>
      {familyThemes.length === 0 && (
        <p className="meta">No themes in this combination — pick another family or style.</p>
      )}
      <span className="meta">
        {THEMES.length} environments across {families.length} families. The one you pick applies everywhere and stays.
      </span>
    </div>
  );
}

/**
 * A theme shown as the environment it creates: the surface ramp as a stack, the
 * atmosphere glow as light bleeding from the corner, and the accent as the
 * label. This is what makes the choice legible before you commit to it.
 */
function EnvironmentTile({
  theme,
  active,
  onPick,
  featured = false,
}: {
  theme: Theme;
  active: boolean;
  onPick: () => void;
  featured?: boolean;
}) {
  const s = rampFor(theme);
  return (
    <button
      className={`env-tile${active ? " sel" : ""}${featured ? " featured" : ""}`}
      aria-pressed={active}
      onClick={onPick}
      title={theme.name}
      style={{
        background: `radial-gradient(120% 90% at 85% -10%, ${theme.accent}33, transparent 60%), linear-gradient(160deg, ${s.s1}, ${s.void})`,
        color: s.text,
        ["--env-accent" as string]: theme.accent,
      }}
    >
      <span className="env-tile-preview" aria-hidden="true">
        <span className="env-tile-surface" style={{ background: s.s2 }} />
        <span className="env-tile-surface" style={{ background: s.s3 }} />
        <span className="env-tile-accent" style={{ background: theme.accent }} />
      </span>
      <span className="env-tile-name">{theme.name}</span>
      <span className="env-tile-meta" style={{ color: s.textMuted }}>
        {theme.family === "signature" ? "Signature" : `${theme.family} · ${theme.style}`}
      </span>
      {active && <span className="env-tile-check" aria-hidden="true"><CheckIcon width={15} height={15} /></span>}
    </button>
  );
}
