import { useEffect } from "react";
import { applyTheme, getTheme, type Theme } from "../themes";

/**
 * Tint the app for whatever the viewer is doing, when "follow activity" is on.
 *
 * A manual pick always wins; the activity theme only applies in follow mode and
 * is reverted when the screen unmounts, so leaving a game returns the app to the
 * viewer's own choice.
 */
export function useActivityTheme(theme: Theme | null): void {
  useEffect(() => {
    if (!theme) return;
    const follow = localStorage.getItem("vibe.theme.follow") === "1";
    const manual = localStorage.getItem("vibe.vibetheme");
    if (!follow || manual) return;
    applyTheme(theme);
    return () => applyTheme(getTheme(localStorage.getItem("vibe.vibetheme")));
  }, [theme?.id]);
}
