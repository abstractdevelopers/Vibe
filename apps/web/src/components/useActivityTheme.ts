import { useEffect } from "react";
import { applyTheme, followActivity, pickedTheme, type Theme } from "../theme-runtime";

/**
 * Give a screen its own environment, when the viewer has not chosen one.
 *
 * Precedence is deliberate and simple:
 *   1. A theme the viewer picked by hand always wins — their choice is not
 *      overridden by walking into a room.
 *   2. Otherwise, if "follow activity" is on (it is on by default), the screen's
 *      own environment applies, so a Whot table feels like a Whot table and a
 *      listening party feels like one.
 *   3. Otherwise the brand default shows through.
 *
 * Leaving the screen reverts to whatever the viewer's standing choice is.
 */
export function useActivityTheme(theme: Theme | null): void {
  useEffect(() => {
    if (!theme) return;
    if (!followActivity() || pickedTheme()) return;
    applyTheme(theme);
    return () => applyTheme(pickedTheme());
  }, [theme?.id]);
}
