(() => {
  if (window.parent === window) return;

  const events = new Set(["PageView", "Search", "ViewContent", "InitiateCheckout", "Schedule"]);
  let started = false;
  let ready = false;
  let pixelId;
  let granted = false;

  function start() {
    started = true;
    // Meta's manual base-code bootstrap, scoped to this sandboxed document.
    const fbq = function () {
      if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
      else fbq.queue.push(arguments);
    };
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    fbq.queue = [];
    fbq.disablePushState = true;
    window.fbq = window._fbq = fbq;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    script.onload = () => {
      ready = typeof fbq.callMethod === "function";
      window.parent.postMessage({ type: "fastque-pixel-ready", ready }, window.location.origin);
    };
    script.onerror = () => {
      window.parent.postMessage({ type: "fastque-pixel-ready", ready: false }, window.location.origin);
    };
    document.head.append(script);
  }

  window.addEventListener("message", ({ source, origin, data }) => {
    if (source !== window.parent || origin !== window.location.origin) return;
    try {
      if (data?.type === "prepare" && !started) {
        start();
      } else if (data?.type === "revoke" && granted) {
        granted = false;
        window.fbq("consent", "revoke");
      } else if (ready && data?.type === "track" && events.has(data.event) &&
          typeof data.pixelId === "string" && /^\d{1,20}$/.test(data.pixelId) &&
          (!pixelId || pixelId === data.pixelId)) {
        if (!granted) {
          window.fbq("consent", "grant");
          granted = true;
        }
        if (!pixelId) {
          pixelId = data.pixelId;
          window.fbq("set", "autoConfig", false, pixelId);
          window.fbq("init", pixelId);
        }
        window.fbq("trackSingle", pixelId, data.event);
      }
    } catch {
      // Meta errors are isolated to this document.
    }
  });
})();
