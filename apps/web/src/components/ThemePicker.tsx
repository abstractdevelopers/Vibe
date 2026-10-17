import { useMemo, useState } from "react";
import { THEMES, applyTheme, getTheme, type Theme } from "../themes";

/**
 * Theme picker.
 *
 * Vibe has a curated palette of activity themes — a colour for every family of
 * game, room and surface, each in four house styles. This lets someone browse
 * them by family, try one live, or let Vibe follow whatever they are doing.
 */

export function ThemePicker() {
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem("vibe.vibetheme"));
  const [follow, setFollow] = useState<boolean>(() => localStorage.getItem("vibe.theme.follow") === "1");

  const families = useMemo(() => [...new Set(THEMES.map((t) => t.family))], []);
  const styles = useMemo(() => [...new Set(THEMES.map((t) => t.style))], []);
  const [family, setFamily] = useState<string>(() => getTheme(selected)?.family ?? families[0]!);
  const [style, setStyle] = useState<string>(() => getTheme(selected)?.style ?? styles[0]!);

  function choose(theme: Theme | null) {
    setSelected(theme?.id ?? null);
    if (theme) localStorage.setItem("vibe.vibetheme", theme.id);
    else localStorage.removeItem("vibe.vibetheme");
    applyTheme(theme);
    window.dispatchEvent(new CustomEvent("vibe:theme"));
  }

  function toggleFollow(next: boolean) {
    setFollow(next);
    localStorage.setItem("vibe.theme.follow", next ? "1" : "0");
    if (next) { applyTheme(null); setSelected(null); localStorage.removeItem("vibe.vibetheme"); }
    window.dispatchEvent(new CustomEvent("vibe:theme"));
  }

  const familyThemes = THEMES.filter((t) => t.family === family);

  return (
    <div className="stack">
      <label className="row spread" style={{ cursor: "pointer" }}>
        <span>
          <span style={{ display: "block", fontWeight: 600 }}>Follow activity</span>
          <span className="meta">Let the theme change with the game or room you are in</span>
        </span>
        <input type="checkbox" checked={follow} onChange={(e) => toggleFollow(e.target.checked)} />
      </label>

      <div className="pill-row">
        <button className="pill" aria-pressed={!selected && !follow} onClick={() => choose(null)}>Vibe default</button>
        {families.map((f) => (
          <button key={f} className="pill" aria-pressed={family === f && !follow} onClick={() => setFamily(f)}>
            {f}
          </button>
        ))}
      </div>

      <div className="pill-row">
        {styles.map((s) => (
          <button key={s} className="pill" aria-pressed={style === s} onClick={() => setStyle(s)}>{s}</button>
        ))}
      </div>

      <div className="theme-grid">
        {familyThemes.map((t) => (
          <button
            key={t.id}
            className={`theme-swatch ${selected === t.id ? "sel" : ""}`}
            style={{ background: t.accent, color: t.accentInk }}
            aria-pressed={selected === t.id}
            onClick={() => choose(t)}
            title={t.name}
          >
            <span className="theme-swatch-name">{t.name}</span>
          </button>
        ))}
      </div>
      <span className="meta">{THEMES.length} themes across {families.length} families.</span>
    </div>
  );
}
