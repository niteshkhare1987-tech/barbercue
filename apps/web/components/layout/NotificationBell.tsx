"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { NOTIFICATION_PATHS } from "@barbercue/shared";
import type { NotificationDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import styles from "./notification-bell.module.css";

const POLL_INTERVAL_MS = 60_000;

const TYPE_LABEL: Record<string, string> = {
  "booking.confirmed": "Booking confirmed",
  "booking.cancelled": "Booking cancelled",
  "booking.no_show": "Booking marked as no-show",
  "booking.expired": "Booking hold expired",
  "booking.corrected": "Booking corrected: marked completed",
  "queue.turn_approaching": "Your turn is approaching",
  "owner.booking.created": "New booking",
  "owner.booking.cancelled": "Booking cancelled",
  "owner.booking.no_show": "Customer no-show",
  "owner.booking.expired": "Unpaid booking expired",
  "owner.walk_in.joined": "New Live Queue customer",
  "staff.assigned": "You were assigned a customer",
  "owner.booking.arrival_check": "Appointment arrival check",
  "booking.cancelled_by_shop": "Appointment cancelled by the shop",
  "booking.rescheduled_by_shop": "Appointment time changed by the shop",
  "owner.inventory.reorder": "Time to reorder stock",
  "owner.inventory.expiring": "Stock expiring soon",
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Notification Center bell (Phase 11) — shared by DashboardHeader (owner/staff/admin) and
 * CustomerHeader, since "my own notifications" is identical regardless of role; only the deep
 * links each notification carries differ, and those come from the backend already resolved.
 * Polls unread-count on an interval rather than a dedicated realtime channel — acceptable latency
 * for a notification-center badge, and avoids adding a new socket event just for this.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(() => {
    apiFetch<{ count: number }>(`${NOTIFICATION_PATHS.notifications}/${NOTIFICATION_PATHS.mine}/${NOTIFICATION_PATHS.unreadCount}`)
      .then((r) => setUnreadCount(r.count))
      .catch(() => {
        /* non-critical widget */
      });
  }, []);

  useEffect(() => {
    refreshCount();
    const id = setInterval(refreshCount, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refreshCount]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && items === null) {
      apiFetch<{ items: NotificationDto[] }>(`${NOTIFICATION_PATHS.notifications}/${NOTIFICATION_PATHS.mine}`)
        .then((r) => setItems(r.items))
        .catch(() => setItems([]));
    }
  }

  function handleItemClick(n: NotificationDto) {
    if (!n.readAt) {
      apiFetch(`${NOTIFICATION_PATHS.notifications}/${n.id}/${NOTIFICATION_PATHS.read}`, { method: "POST" }).catch(() => {});
      setItems((prev) => (prev ?? []).map((it) => (it.id === n.id ? { ...it, readAt: new Date().toISOString() } : it)));
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    setOpen(false);
  }

  function markAllRead() {
    apiFetch(`${NOTIFICATION_PATHS.notifications}/${NOTIFICATION_PATHS.mine}/${NOTIFICATION_PATHS.readAll}`, { method: "POST" })
      .then(() => {
        setUnreadCount(0);
        setItems((prev) => (prev ?? []).map((it) => ({ ...it, readAt: it.readAt ?? new Date().toISOString() })));
      })
      .catch(() => {});
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-label="Notifications"
        aria-expanded={open}
        style={{
          position: "relative",
          background: "none",
          border: "1px solid var(--bc-border)",
          borderRadius: 8,
          width: 36,
          height: 36,
          cursor: "pointer",
          fontSize: 16,
        }}
      >
        🔔
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              background: "var(--bc-accent)",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 999,
              minWidth: 16,
              height: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 3px",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={styles.panel}
          style={{
            background: "var(--bc-surface)",
            border: "1px solid var(--bc-border)",
            borderRadius: "var(--bc-radius-md)",
            boxShadow: "var(--bc-shadow-lg)",
            zIndex: 60,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--bc-border)" }}>
            <strong style={{ fontSize: 13 }}>Notifications</strong>
            {unreadCount > 0 && (
              <button type="button" onClick={markAllRead} style={{ background: "none", border: "none", color: "var(--bc-muted)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>
                Mark all read
              </button>
            )}
          </div>
          {items === null && <p style={{ padding: 14, fontSize: 13, color: "var(--bc-muted)" }}>Loading…</p>}
          {items?.length === 0 && <p style={{ padding: 14, fontSize: 13, color: "var(--bc-muted)" }}>No notifications yet.</p>}
          {items?.map((n) => {
            const content = (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                {!n.readAt && (
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--bc-accent)", marginTop: 5, flexShrink: 0 }} />
                )}
                <div>
                  <div style={{ fontSize: 13, fontWeight: n.readAt ? 500 : 700, color: "var(--bc-ink)" }}>
                    {TYPE_LABEL[n.type] ?? n.type}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--bc-muted)", marginTop: 2 }}>{timeAgo(n.createdAt)}</div>
                </div>
              </div>
            );
            return n.deepLink ? (
              <Link
                key={n.id}
                href={`/${n.deepLink}`}
                role="menuitem"
                onClick={() => handleItemClick(n)}
                style={{ display: "block", padding: "10px 14px", borderBottom: "1px solid var(--bc-border)" }}
              >
                {content}
              </Link>
            ) : (
              <div
                key={n.id}
                role="menuitem"
                tabIndex={0}
                onClick={() => handleItemClick(n)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleItemClick(n);
                  }
                }}
                style={{ padding: "10px 14px", borderBottom: "1px solid var(--bc-border)", cursor: "pointer" }}
              >
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
