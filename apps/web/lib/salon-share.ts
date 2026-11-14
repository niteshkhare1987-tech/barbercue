import { absoluteUrl } from "./seo";
import { composeMessage, facebookShareUrl, whatsappShareUrl } from "./shop-share";

// Customer "Share this salon". The link is always the salon's canonical public profile URL from the
// existing routing (/:countryCode/:citySlug/:salonSlug) — no new URL scheme, and nothing private
// (no booking, customer or referral data) is ever added to it.

export interface ShareableSalon {
  name: string;
  slug: string;
  citySlug: string;
  countryCode: string;
}

export function salonProfilePath(salon: ShareableSalon): string {
  return `/${salon.countryCode.toLowerCase()}/${salon.citySlug}/${salon.slug}`;
}

/** Absolute canonical URL. In the browser the current origin is used so the link opens this deployment. */
export function salonShareUrl(salon: ShareableSalon, origin?: string): string {
  const path = salonProfilePath(salon);
  return origin ? `${origin.replace(/\/+$/, "")}${path}` : absoluteUrl(path);
}

export function salonShareText(salon: ShareableSalon): string {
  return `Found a great salon on FastQue: ${salon.name}. Book a time or join the live queue.`;
}

export function salonShareTargets(salon: ShareableSalon, url: string) {
  const text = salonShareText(salon);
  return {
    whatsapp: whatsappShareUrl(text, url),
    facebook: facebookShareUrl(url),
    // X web intent: the user reviews and posts it themselves.
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    message: composeMessage(text, url),
  };
}
