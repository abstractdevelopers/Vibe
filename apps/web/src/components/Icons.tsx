/**
 * Hand-tuned line icons. Consistent 24px grid, 1.9 stroke, round caps, so the
 * whole set reads as one family rather than a bag of borrowed glyphs.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    width: 24,
    height: 24,
    "aria-hidden": true,
    ...props,
  };
}

export function HomeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 10.4 12 3.6l8.5 6.8" />
      <path d="M5.5 9.6V20h13V9.6" />
      <path d="M9.8 20v-5.4h4.4V20" />
    </svg>
  );
}

export function CirclesIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8.4" r="3.4" />
      <path d="M2.8 20c.5-3.6 3.1-5.6 6.2-5.6s5.7 2 6.2 5.6" />
      <path d="M16.4 5.6a3.2 3.2 0 0 1 0 6.2" />
      <path d="M18.2 14.8c1.9.7 3.2 2.4 3.5 5.2" />
    </svg>
  );
}

export function CompassIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m15.4 8.6-2 5.2-5.2 2 2-5.2z" />
    </svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8.2" r="3.7" />
      <path d="M4.6 20.4c.7-3.9 3.7-6 7.4-6s6.7 2.1 7.4 6" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props)} strokeWidth={2.4}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 6.5h16v13H4z" />
      <path d="m4 12.5 4.2-2.4 3.8 2.4 3.8-2.4L20 12.5" />
    </svg>
  );
}

export function HeartIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 20s-7.6-4.6-7.6-9.6A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.6 2.8C19.6 15.4 12 20 12 20z" />
    </svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M20 12.6c0 4-3.6 7-8 7a9 9 0 0 1-2.6-.4L5 21l1-3.3a6.6 6.6 0 0 1-2-4.7c0-4 3.6-7.1 8-7.1s8 3.1 8 7z" />
    </svg>
  );
}

export function ShareIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 15V4.4" />
      <path d="m8.4 7.8 3.6-3.6 3.6 3.6" />
      <path d="M5 13.6V20h14v-6.4" />
    </svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.6" y="5" width="16.8" height="15" rx="3" />
      <path d="M3.6 9.6h16.8M8.4 3.4v3.2M15.6 3.4v3.2" />
    </svg>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.4l1.9 5.3 5.3 1.9-5.3 1.9L12 17.8l-1.9-5.3L4.8 10.6l5.3-1.9z" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.4l7 2.6v5.4c0 4.4-3 7.4-7 8.8-4-1.4-7-4.4-7-8.8V6z" />
      <path d="m9.2 12.2 2 2 3.6-3.9" />
    </svg>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.4" y="6" width="17.2" height="12.6" rx="3.2" />
      <path d="M3.4 10.4h17.2" />
      <circle cx="16.4" cy="14.2" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m5 12.6 4.4 4.4L19 6.8" />
    </svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M15 5.5 8.5 12l6.5 6.5" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6" />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4.8" y="10.4" width="14.4" height="9.4" rx="2.6" />
      <path d="M8.2 10.4V8a3.8 3.8 0 0 1 7.6 0v2.4" />
    </svg>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.6 12h16.8M12 3.4c2.3 2.4 3.4 5.3 3.4 8.6S14.3 18.2 12 20.6C9.7 18.2 8.6 15.3 8.6 12S9.7 5.8 12 3.4z" />
    </svg>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8.6" r="3.4" />
      <path d="M5.4 19.6c.6-3.4 3.3-5.3 6.6-5.3s6 1.9 6.6 5.3" />
    </svg>
  );
}

export function MapPinIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 21c4-4.4 6-7.6 6-10.4a6 6 0 1 0-12 0C6 13.4 8 16.6 12 21z" />
      <circle cx="12" cy="10.4" r="2.3" />
    </svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M20 14.4A8 8 0 0 1 9.6 4a8 8 0 1 0 10.4 10.4z" />
    </svg>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M14.6 5H6.4v14h8.2" />
      <path d="M12 12h8.4M17.4 8.8 20.6 12l-3.2 3.2" />
    </svg>
  );
}
