import { useEffect } from "react";
import { applyTheme, pickedTheme, themeMode, type Theme } from "../theme-runtime";

/**
 * Give a screen its own environment, when the viewer has asked for that.
 *
 * Precedence is deliberate and simple:
 *   1. A theme the viewer pinned by hand always wins — their choice is not
 *      overridden by walking into a room.
 *   2. Auto (the default) keeps the rotating environment steady, so walking into
 *      a room does not yank the whole app to a room's colour and back.
 *   3. Only "follow activity" lets the screen's own environment apply, so a Whot
 *      table feels like a Whot table and a listening party feels like one.
 *
 * Leaving the screen reverts to whatever the viewer's standing choice is.
 */
export function useActivityTheme(theme: Theme | null): void {
  useEffect(() => {
    if (!theme) return;
    if (themeMode() !== "follow") return;
    applyTheme(theme);
    return () => applyTheme(pickedTheme());
  }, [theme?.id]);
}
