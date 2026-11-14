// Minimal line icons for the customer dashboard (24px grid, currentColor, 1.8 stroke).
import type { ReactNode } from "react";

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export type IconName =
  | "home" | "search" | "calendar" | "heart" | "gift" | "star" | "invoice" | "settings"
  | "queue" | "trophy" | "pin" | "clock" | "crown" | "sparkle" | "more" | "user" | "directions" | "history";

const PATHS: Record<IconName, ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  heart: <path d="M12 20.3s-7.6-4.6-9.3-9.2C1.6 8 3.6 4.7 6.9 4.7c2 0 3.3 1.1 5.1 3 1.8-1.9 3.1-3 5.1-3 3.3 0 5.3 3.3 4.2 6.4-1.7 4.6-9.3 9.2-9.3 9.2z" />,
  gift: <><rect x="3.5" y="8.5" width="17" height="4" rx="1" /><path d="M5 12.5V21h14v-8.5M12 8.5V21" /><path d="M12 8.5S10.8 4 8.3 4.2C6.6 4.3 6.6 7 8.6 8.5M12 8.5S13.2 4 15.7 4.2c1.7.1 1.7 2.8-.3 4.3" /></>,
  star: <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  invoice: <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 11h7M9 15h7M9 19h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  queue: <><circle cx="8" cy="8" r="2.6" /><circle cx="16.5" cy="8.5" r="2.2" /><path d="M3 19c.4-3 2.4-5 5-5s4.6 2 5 5M13.5 14.4c.9-.6 1.9-.9 3-.9 2.3 0 4 1.8 4.5 4.5" /></>,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0z" /><path d="M8 6H4.5a3 3 0 0 0 3.6 4M16 6h3.5a3 3 0 0 1-3.6 4M12 13v4M8.5 20h7M10 17h4" /></>,
  pin: <><path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  crown: <path d="m4 8 4 4 4-6 4 6 4-4-1.5 10h-13z" />,
  sparkle: <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9-5.7-1.8L10.2 9z" />,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  user: <><circle cx="12" cy="8" r="3.8" /><path d="M4.5 20.5c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6" /></>,
  directions: <path d="m4 11 16-7-7 16-2-7z" />,
  history: <><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4v4h4M12 7.5V12l3 2" /></>,
};

export function DashIcon({ name, size }: { name: IconName; size?: number }) {
  return <Icon size={size}>{PATHS[name]}</Icon>;
}
