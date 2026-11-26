// Customer dashboard feature flags. Build-time public env vars; anything not explicitly "true" is OFF.
//
// GIFT CARDS stay OFF until merchant settlement, accounting, GST treatment and RBI prepaid-payment-
// instrument applicability have been reviewed and a payment flow exists. With the flag off, the
// Rewards page explains the feature is not yet available and no purchase/issuance UI is reachable.
// Even with the flag on, this web build only previews a gift card: there is no issuance backend.

export function giftCardsEnabled(env: string | undefined = process.env.NEXT_PUBLIC_FEATURE_GIFT_CARDS): boolean {
  return env === "true";
}

/** FastQue Work (student gigs) entry points on the public site — the homepage hero link and banner.
 *  Keep OFF until the backend runs with WORK_MARKETPLACE_ENABLED=true, otherwise /work answers 404. */
export function workMarketplaceLinksEnabled(env: string | undefined = process.env.NEXT_PUBLIC_WORK_MARKETPLACE_ENABLED): boolean {
  return env === "true";
}

/** FastQue Home entry points on the website (landing page, customer and owner menus, /home-services).
 *  Keep OFF until the backend runs with FASTQUE_HOME_ENABLED=true. The admin section is always listed. */
export function homeServicesLinksEnabled(env: string | undefined = process.env.NEXT_PUBLIC_FASTQUE_HOME_ENABLED): boolean {
  return env === "true";
}

/** FastQue Commerce in the admin sidebar. Keep OFF until the backend runs with
 *  FASTQUE_DIRECT_COMMERCE_ENABLED=true (the API answers 404 until then). */
export function directCommerceLinksEnabled(env: string | undefined = process.env.NEXT_PUBLIC_FASTQUE_DIRECT_COMMERCE_ENABLED): boolean {
  return env === "true";
}

/** Map tiles. Defaults to OpenStreetMap's public tiles (fine for development; set a commercial
 *  provider for production traffic — OSM's tile policy forbids heavy use). */
export const MAP_TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL ?? "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const MAP_TILE_ATTRIBUTION =
  process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION ?? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
