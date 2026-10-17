import { useMemo, useState } from "react";
import { CheckIcon } from "./Icons";
import { THEMES, getTheme } from "../themes";
import { chooseTheme, pickedTheme, rampFor, setThemeMode, themeMode, type Theme, type ThemeMode } from "../theme-runtime";

/**
 * Theme picker.
 *
 * Vibe has a catalogue of environments — a mood for every family of game, room
 * and surface, each in four house styles, plus four signature environments
 * (Neon Arcade, Obsidian Lounge, Cyber Arena, Royal Chamber). This lets someone
 * browse them by family, preview each one as an actual environment (its
 * surfaces, its accent, its atmosphere), try it live, or pin one for good.
 *
 * The default is Auto: Vibe rotates through the four signature worlds between
 * visits, so the product has a mood without anyone choosing one. Picking any
 * tile pins it; "Let it rotate" returns to Auto.
 *
 * Selecting is immediate and persistent: it writes the theme to localStorage and
 * applies the full surface ramp to the document root, so the whole app changes —
 * not just the accent on a button.
 */

export function ThemePicker() {
  const [mode, setMode] = useState<ThemeMode>(() => themeMode());
  const [selected, setSelected] = useState<string | null>(() => (themeMode() === "pinned" ? pickedTheme()?.id ?? null : null));

  const families = useMemo(() => [...new Set(THEMES.map((t) => t.family))], []);
  const styles = useMemo(() => [...new Set(THEMES.map((t) => t.style))], []);
  const [family, setFamily] = useState<string>(() => getTheme(selected)?.family ?? "cards");
  const [style, setStyle] = useState<string>(() => getTheme(selected)?.style ?? "classic");

  function choose(theme: Theme | null) {
    setSelected(theme?.id ?? null);
    if (theme) setMode("pinned");
    chooseTheme(theme);
    setThemeMode(theme ? "pinned" : "auto");
  }

  function setAuto() {
    setSelected(null);
    setMode("auto");
    setThemeMode("auto");
    // Show what auto currently resolves to, so the choice is not invisible.
    window.dispatchEvent(new CustomEvent("vibe:theme"));
  }

  const familyThemes = THEMES.filter((t) => t.family === family && t.style === style);

  return (
    <div className="stack">
      <div className="mode-row" role="radiogroup" aria-label="How Vibe picks an environment">
        <button className={`mode-card${mode === "auto" ? " sel" : ""}`} role="radio" aria-checked={mode === "auto"} onClick={setAuto}>
          <span className="mode-card-title">Let it rotate</span>
          <span className="mode-card-sub">Vibe changes the mood between visits — the default</span>
        </button>
        <button className={`mode-card${mode === "pinned" ? " sel" : ""}`} role="radio" aria-checked={mode === "pinned"} onClick={() => setMode("pinned")}>
          <span className="mode-card-title">Pin one</span>
          <span className="mode-card-sub">Pick an environment below and it stays</span>
        </button>
        <button className={`mode-card${mode === "follow" ? " sel" : ""}`} role="radio" aria-checked={mode === "follow"} onClick={() => { setMode("follow"); setThemeMode("follow"); }}>
          <span className="mode-card-title">Follow the room</span>
          <span className="mode-card-sub">The environment changes with the game or room you enter</span>
        </button>
      </div>

      <div>
        <p className="eyebrow" style={{ marginBottom: "var(--space-2)" }}>Signature environments</p>
        <div className="env-feature-grid">
          {THEMES.filter((t) => t.family === "signature").map((t) => (
            <EnvironmentTile key={t.id} theme={t} active={mode === "pinned" && selected === t.id} onPick={() => choose(t)} featured />
          ))}
        </div>
      </div>

      <div className="pill-row" role="tablist" aria-label="Theme family">
        {families.filter((f) => f !== "signature").map((f) => (
          <button key={f} className="pill" aria-pressed={family === f} onClick={() => setFamily(f)}>
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
          <EnvironmentTile key={t.id} theme={t} active={mode === "pinned" && selected === t.id} onPick={() => choose(t)} />
        ))}
      </div>
      {familyThemes.length === 0 && (
        <p className="meta">No themes in this combination — pick another family or style.</p>
      )}
      <span className="meta">
        {THEMES.length} environments across {families.length} families. Pick one and it applies everywhere and stays.
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
