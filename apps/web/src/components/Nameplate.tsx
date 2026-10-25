import { useNav } from "../nav";
import type { PublicNameplate } from "../types";

/**
 * A nameplate: who someone is, everywhere their name appears.
 *
 * The title is earned (derived from this week's activity) and the frame is
 * bought, with a numbered edition. Both were visible only on the Status screen,
 * which made status a page nobody visits rather than a thing people see. This
 * renders the same pair next to a name in a feed, a thread, a room or a table.
 *
 * Deliberately quiet. A nameplate is read while scanning a feed, so it sits on
 * the meta line at metadata size; a limited edition says its number in words
 * ("No. 7 of 100") because "No. 7" alone reads as a count.
 */

export function Nameplate({
  plate,
  userId,
  showFrame = true,
}: {
  plate?: PublicNameplate | null;
  /** Whose plate it is, so the frame can open their profile. */
  userId?: string;
  /** The frame is a ring on the avatar; only the owner of the name may skip it. */
  showFrame?: boolean;
}) {
  const nav = useNav();
  const hasTitle = Boolean(plate?.title);
  const frame = showFrame ? plate?.frame ?? null : null;
  if (!hasTitle && !frame) return null;

  const edition = frame?.serial && frame.editionSize ? `No. ${frame.serial} of ${frame.editionSize}` : frame?.label ?? null;

  return (
    <span className="nameplate">
      {hasTitle && (
        <span className={`nameplate-title rank-${plate?.rank ?? "none"}`}>
          {plate!.title}
        </span>
      )}
      {frame && (
        <button
          className="nameplate-wear"
          onClick={() => { if (userId) nav.push({ name: "profile", userId }); }}
          title={`${frame.label}${edition ? ` · ${edition}` : ""}`}
        >
          <span className={`nameplate-dot style-${frame.style}`} aria-hidden />
          {edition}
        </button>
      )}
    </span>
  );
}
