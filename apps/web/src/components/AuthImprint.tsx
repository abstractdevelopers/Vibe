/**
 * The auth imprint.
 *
 * A faded, hand-drawn scene behind the sign-up hero: a few people around a
 * table with the things Vibe is for between them — a plan, a game, a song, a
 * place. It is drawn here rather than imported so it is ours, it is vector so
 * it stays crisp, and it is decorative, so it is hidden from assistive tech and
 * never carries meaning the copy does not already give.
 *
 * Stroke widths and opacity are deliberately low: this should read as an
 * imprint under the content, not as an illustration competing with it.
 */
export function AuthImprint({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 640 640"
      fill="none"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
    >
      <g
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      >
        {/* A loose table, the anchor of the scene. */}
        <path d="M150 470c0-14 76-24 170-24s170 10 170 24-76 24-170 24-170-10-170-24Z" />
        <path d="M182 492c0 22-6 40-14 56M458 492c0 22 6 40 14 56" />

        {/* Three figures around it — heads, shoulders, a raised cup. */}
        <path d="M232 420c0-22 16-38 34-38s34 16 34 38" />
        <circle cx="266" cy="368" r="22" />
        <path d="M300 356c8-16 26-24 44-20 16 4 26 18 26 34" />
        <circle cx="352" cy="322" r="20" />
        <path d="M372 402c14-10 34-10 48 2M150 448c-6-16-2-34 10-44M470 442c8-16 6-34-4-46" />

        {/* A plan: a small card with lines and a tick. */}
        <rect x="196" y="286" width="86" height="64" rx="10" transform="rotate(-8 196 286)" />
        <path d="M214 312h44M214 326h30" />
        <path d="M258 334l8 8 14-16" />

        {/* A game: two dice, one showing a pip. */}
        <rect x="356" y="196" width="46" height="46" rx="9" transform="rotate(12 356 196)" />
        <rect x="404" y="228" width="42" height="42" rx="9" transform="rotate(-6 404 228)" />
        <circle cx="380" cy="220" r="3.4" fill="currentColor" stroke="none" />
        <circle cx="424" cy="250" r="3.4" fill="currentColor" stroke="none" />

        {/* A song, rising from the table. */}
        <path d="M452 404v-70l46-12v70" />
        <circle cx="444" cy="406" r="12" />
        <circle cx="490" cy="394" r="12" />

        {/* A place: a pin over the horizon. */}
        <path d="M120 210c0-20 16-36 36-36s36 16 36 36c0 26-36 54-36 54s-36-28-36-54Z" />
        <circle cx="156" cy="208" r="12" />

        {/* Sparkles — the brand's own mark, scattered lightly. */}
        <path d="M300 150l6 16 16 6-16 6-6 16-6-16-16-6 16-6 6-16Z" />
        <path d="M508 320l4 11 11 4-11 4-4 11-4-11-11-4 11-4 4-11Z" />
        <path d="M120 380l4 11 11 4-11 4-4 11-4-11-11-4 11-4 4-11Z" />
      </g>
    </svg>
  );
}
