import type { ReactNode } from "react";

/**
 * The one empty state used everywhere. The spec requires an empty state with a
 * next action, so every instance pairs a plain-language line with a control
 * that does something — never a bare "nothing here" that leaves the user stuck.
 */
export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="empty-title">{title}</p>
      <p className="empty-text">{text}</p>
      {action}
    </div>
  );
}
