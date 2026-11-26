const preferenceKey = "fastque_advertising_consent_v1";
const preferenceEvent = "fastque-advertising-preference";

type Preference = "allow" | "deny" | "unset" | "blocked";
type PixelEvent = "PageView" | "Search" | "ViewContent" | "InitiateCheckout" | "Schedule";

export function advertisingPreference(): Preference {
  try {
    if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return "blocked";
    const stored = localStorage.getItem(preferenceKey);
    return stored === "allow" || stored === "deny" ? stored : "unset";
  } catch {
    return "blocked";
  }
}

export function subscribeToAdvertisingPreference(update: () => void) {
  window.addEventListener("storage", update);
  window.addEventListener(preferenceEvent, update);
  return () => {
    window.removeEventListener("storage", update);
    window.removeEventListener(preferenceEvent, update);
  };
}

export function setAdvertisingPreference(preference: "allow" | "deny") {
  try {
    localStorage.setItem(preferenceKey, preference);
  } catch {
    // Storage failures leave tracking disabled.
  }
  if (advertisingPreference() !== "allow") suspendMetaPixel();
  window.dispatchEvent(new Event(preferenceEvent));
}

const publicPages = new Set(["/", "/search", "/offers", "/about-us", "/faq", "/privacy-policy", "/contact-us", "/app", "/careers"]);
const discoveryPage = /^\/[a-z]{2}\/[a-z0-9-]+(?:\/(?:[a-z0-9-]+|areas\/[a-z0-9-]+))?$/;
const bookingPage = /^\/book\/[a-z0-9-]+$/;

export function isPixelPath(pathname: string) {
  const path = pathname.replace(/\/$/, "") || "/";
  return publicPages.has(path) || discoveryPage.test(path) || bookingPage.test(path);
}

export async function getMetaPixelId(): Promise<string | null> {
  try {
    const response = await fetch("/advertising-config", {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const { pixelId } = await response.json();
    return typeof pixelId === "string" && /^\d{1,20}$/.test(pixelId) ? pixelId : null;
  } catch {
    return null;
  }
}

let frame: HTMLIFrameElement | undefined;
let frameReady: Promise<boolean> | undefined;
let generation = 0;
let work = Promise.resolve();
const sent = new Set<string>();

function prepareFrame(stillAllowed: () => boolean) {
  if (frameReady) return frameReady;
  const element = document.createElement("iframe");
  element.hidden = true;
  element.title = "Advertising measurement";
  element.sandbox.add("allow-scripts");
  element.referrerPolicy = "no-referrer";
  element.src = "/meta-pixel-frame.html";
  frame = element;
  frameReady = new Promise<boolean>((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(ready);
    };
    const onMessage = (message: MessageEvent) => {
      if (message.source === element.contentWindow && message.origin === "null" &&
          message.data?.type === "fastque-pixel-ready") finish(message.data.ready === true);
    };
    const timeout = window.setTimeout(() => finish(false), 4000);
    window.addEventListener("message", onMessage);
    element.addEventListener("load", () => {
      if (stillAllowed()) element.contentWindow?.postMessage({ type: "prepare" }, "*");
      else finish(false);
    }, { once: true });
  }).then((ready) => {
    if (!ready) {
      element.remove();
      frame = undefined;
      frameReady = undefined;
    }
    return ready;
  });
  document.body.append(element);
  return frameReady;
}

export function suspendMetaPixel() {
  generation++;
  try {
    frame?.contentWindow?.postMessage({ type: "revoke" }, "*");
  } catch {
    // Reporting is best effort.
  }
}

export function trackMetaPixel(event: PixelEvent, dedupeKey?: string) {
  if (typeof window === "undefined" || advertisingPreference() !== "allow") return;
  const path = window.location.pathname;
  if (!isPixelPath(path)) return;
  const started = generation;
  const key = dedupeKey ? `${event}:${dedupeKey}` : undefined;
  const stillAllowed = () =>
    started === generation && window.location.pathname === path && advertisingPreference() === "allow";

  work = work.then(async () => {
    if (!stillAllowed() || (key && sent.has(key))) return;
    let pixelId = await getMetaPixelId();
    if (!stillAllowed()) return;
    if (!pixelId) {
      suspendMetaPixel();
      return;
    }
    if (!frameReady) {
      if (!await prepareFrame(stillAllowed) || !stillAllowed()) return;
      // The flag may have changed while the external SDK was loading.
      pixelId = await getMetaPixelId();
      if (!pixelId) return;
    }
    if (!stillAllowed() || !frame?.contentWindow) return;
    // The sandbox has an opaque origin. The frame authenticates the parent and accepts fixed event names only.
    frame.contentWindow.postMessage({ type: "track", pixelId, event }, "*");
    if (key) sent.add(key);
  }).catch(() => undefined);
}
