import { Suspense, lazy, useState } from "react";
import { Avatar2D } from "./Avatar2D";

const Avatar3D = lazy(() => import("./Avatar3D").then((m) => ({ default: m.Avatar3D })));

/**
 * The avatar preview in the profile editor.
 *
 * A photo always wins, so this is only shown when there is none. The 2D face is
 * drawn inline; the 3D head is a lazy chunk, because the software renderer is
 * only worth downloading by the people who actually tap 3D. If the chunk is
 * still loading, the 2D face stays on screen rather than showing a spinner over
 * an empty circle.
 */
export function AvatarStudio({ seed, name, size = 64 }: { seed: string; name: string; size?: number }) {
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  return (
    <div className="avatar-studio">
      <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
        {mode === "2d" ? (
          <Avatar2D seed={seed} fluid />
        ) : (
          <Suspense fallback={<Avatar2D seed={seed} fluid />}>
            <Avatar3D seed={seed} size={size} title={`${name}'s avatar`} />
          </Suspense>
        )}
      </span>
      <div className="avatar-studio-switch" role="group" aria-label="Avatar style">
        <button
          type="button"
          className="pill"
          aria-pressed={mode === "2d"}
          onClick={() => setMode("2d")}
        >
          2D
        </button>
        <button
          type="button"
          className="pill"
          aria-pressed={mode === "3d"}
          onClick={() => setMode("3d")}
        >
          3D
        </button>
      </div>
    </div>
  );
}
