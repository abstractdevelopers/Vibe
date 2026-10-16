import type { ReactNode } from "react";

/**
 * The standard screen heading. Every top-level screen gets an eyebrow line, a
 * title and a one-line subtitle, so a screen never opens as a bare word on an
 * empty page. The whole block eases in so navigation has a beat to it.
 */
export function ScreenHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="screen-header">
      <div className="screen-header-text">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="screen-title" style={{ margin: 0 }}>
          {title}
        </h1>
        {subtitle && <p className="screen-subtitle">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
