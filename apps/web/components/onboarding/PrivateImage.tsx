"use client";

import { useEffect, useState } from "react";
import { apiFetchBlob } from "../../lib/api";

/**
 * Onboarding photos are private: they are fetched with the signed-in user's token and shown from
 * a temporary object URL, never from a public link.
 */
export function PrivateImage({ path, alt, className }: { path: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    apiFetchBlob(path)
      .then(({ blob }) => {
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (failed) return <span role="img" aria-label={`${alt} (unavailable)`}>Image unavailable</span>;
  if (!src) return <span aria-busy="true">Loading…</span>;
  // eslint-disable-next-line @next/next/no-img-element -- object URL of a private, authenticated file
  return <img src={src} alt={alt} className={className} />;
}
