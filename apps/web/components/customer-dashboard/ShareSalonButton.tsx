"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { salonShareTargets, salonShareUrl, type ShareableSalon } from "../../lib/salon-share";
import styles from "./share.module.css";

/**
 * Share icon for salon cards / detail pages. Opens a sheet with Copy link, WhatsApp, Facebook, X,
 * the device share sheet (which is how Instagram and other apps receive a link) and a QR code.
 * Every option is an ordinary link the customer sends themselves; FastQue posts nothing.
 */
export function ShareSalonButton({ salon, variant = "overlay" }: { salon: ShareableSalon; variant?: "overlay" | "inline" | "text" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`${styles.trigger} ${styles[variant]}`}
        aria-label={`Share ${salon.name}`}
        title="Share this salon"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <ShareIcon />
        {variant === "text" && <span>Share</span>}
      </button>
      {open && <ShareSheet salon={salon} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="19" r="2.6" />
      <path d="M8.3 10.8 15.7 6.3M8.3 13.2l7.4 4.5" />
    </svg>
  );
}

export function ShareSheet({ salon, onClose }: { salon: ShareableSalon; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [showQr, setShowQr] = useState(false);
  const url = typeof window === "undefined" ? salonShareUrl(salon) : salonShareUrl(salon, window.location.origin);
  const targets = salonShareTargets(salon, url);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: salon.name, text: targets.message.replace(url, "").trim(), url });
    } catch {
      /* the customer closed the share sheet — nothing to do */
    }
  }

  // Only ever rendered after a click, so document exists.
  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <div>
            <h2 id={titleId}>Share this Salon</h2>
            <p>Found a great salon? Share it with your friends.</p>
          </div>
          <button ref={closeRef} type="button" className={styles.close} onClick={onClose} aria-label="Close share options">×</button>
        </div>
        <p className={styles.salonName}>{salon.name}</p>
        <div className={styles.targets}>
          <button type="button" className={styles.target} onClick={() => void copy()}>
            <span className={`${styles.badge} ${styles.copy}`} aria-hidden="true">🔗</span>
            Copy link
          </button>
          <a className={styles.target} href={targets.whatsapp} target="_blank" rel="noopener noreferrer">
            <span className={`${styles.badge} ${styles.whatsapp}`} aria-hidden="true">W</span>
            WhatsApp
          </a>
          <a className={styles.target} href={targets.facebook} target="_blank" rel="noopener noreferrer">
            <span className={`${styles.badge} ${styles.facebook}`} aria-hidden="true">f</span>
            Facebook
          </a>
          <a className={styles.target} href={targets.x} target="_blank" rel="noopener noreferrer">
            <span className={`${styles.badge} ${styles.x}`} aria-hidden="true">X</span>
            X
          </a>
          {canNativeShare && (
            <button type="button" className={styles.target} onClick={() => void nativeShare()}>
              <span className={`${styles.badge} ${styles.more}`} aria-hidden="true">⋯</span>
              Instagram &amp; more
            </button>
          )}
          <button type="button" className={styles.target} onClick={() => setShowQr((v) => !v)} aria-expanded={showQr}>
            <span className={`${styles.badge} ${styles.qr}`} aria-hidden="true">▦</span>
            QR code
          </button>
        </div>
        <div className={styles.linkRow}>
          <input readOnly value={url} aria-label="Salon link" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" onClick={() => void copy()}>{copied === "ok" ? "Copied ✓" : "Copy"}</button>
        </div>
        <p className={styles.note} role="status">
          {copied === "ok"
            ? "Link copied. Paste it anywhere — including an Instagram story or DM."
            : copied === "failed"
              ? "Couldn’t copy automatically. Select the link above and copy it."
              : canNativeShare
                ? "Instagram has no web share link — use “Instagram & more” or copy the link."
                : "Instagram has no web share link — copy the link and paste it in Instagram."}
        </p>
        {showQr && (
          <div className={styles.qr}>
            <QRCodeSVG value={url} size={168} marginSize={2} title={`QR code for ${salon.name}`} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
