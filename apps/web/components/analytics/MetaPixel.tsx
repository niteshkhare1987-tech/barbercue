"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  advertisingPreference,
  getMetaPixelId,
  isPixelPath,
  setAdvertisingPreference,
  subscribeToAdvertisingPreference,
  suspendMetaPixel,
  trackMetaPixel,
} from "../../lib/meta-pixel";
import styles from "./meta-pixel.module.css";

const serverPreference = () => "unset" as const;

export function MetaPixel() {
  const pathname = usePathname();
  const eligible = isPixelPath(pathname);
  const preference = useSyncExternalStore(subscribeToAdvertisingPreference, advertisingPreference, serverPreference);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const visit = useRef<{ pathname: string; reported: boolean } | null>(null);

  useEffect(() => {
    if (!eligible) return;
    let active = true;
    void getMetaPixelId().then((id) => {
      if (active) setEnabled(Boolean(id));
    });
    return () => { active = false; };
  }, [eligible, pathname]);

  useEffect(() => {
    if (visit.current?.pathname !== pathname) visit.current = { pathname, reported: false };
    if (!eligible || preference !== "allow") {
      suspendMetaPixel();
    } else if (!visit.current.reported) {
      visit.current.reported = true;
      trackMetaPixel("PageView");
    }
  }, [eligible, pathname, preference]);

  if (!eligible || !enabled || preference === "blocked") return null;
  if (!open && preference !== "unset") {
    return <button type="button" className={styles.settings} onClick={() => setOpen(true)}>Advertising choices</button>;
  }

  function choose(choice: "allow" | "deny") {
    setAdvertisingPreference(choice);
    setOpen(false);
  }

  return (
    <section className={styles.panel} aria-label="Advertising choices">
      <p>Allow Meta Pixel to measure how people find and use FastQue? You can change your choice anytime.</p>
      <Link href="/privacy-policy#advertising">Privacy policy</Link>
      <div className={styles.actions}>
        <button type="button" onClick={() => choose("deny")}>Decline</button>
        <button type="button" onClick={() => choose("allow")}>Allow advertising</button>
      </div>
    </section>
  );
}

export function MetaSalonView() {
  const preference = useSyncExternalStore(subscribeToAdvertisingPreference, advertisingPreference, serverPreference);
  const reported = useRef(false);
  useEffect(() => {
    if (preference !== "allow" || reported.current) return;
    reported.current = true;
    trackMetaPixel("ViewContent");
  }, [preference]);
  return null;
}
