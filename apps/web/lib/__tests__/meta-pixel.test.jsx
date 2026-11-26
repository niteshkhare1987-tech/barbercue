import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { GET } from "../../app/advertising-config/route";
import { advertisingPreference, isPixelPath } from "../meta-pixel";

test.each(["/", "/search", "/in/mumbai", "/in/mumbai/areas/bandra", "/in/mumbai/salon", "/book/salon"])(
  "allows the customer-facing path %s",
  (path) => expect(isPixelPath(path)).toBe(true),
);

test.each(["/dashboard/admin", "/dashboard/salons/shop", "/admin/login", "/employee", "/q/token", "/account/bookings", "/queue/salon", "/assistant"])(
  "excludes the path %s",
  (path) => expect(isPixelPath(path)).toBe(false),
);

test("requires explicit consent and honors Global Privacy Control and storage failures", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { globalPrivacyControl: false } });
  const getItem = jest.fn().mockReturnValue(null);
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem } });
  try {
    expect(advertisingPreference()).toBe("unset");
    getItem.mockReturnValue("deny");
    expect(advertisingPreference()).toBe("deny");
    getItem.mockReturnValue("allow");
    expect(advertisingPreference()).toBe("allow");
    navigator.globalPrivacyControl = true;
    expect(advertisingPreference()).toBe("blocked");
    navigator.globalPrivacyControl = false;
    getItem.mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(advertisingPreference()).toBe("blocked");
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  }
});

test("evaluates the flag and emergency marker at request time without caching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastque-pixel-"));
  const marker = join(directory, "disabled");
  jest.replaceProperty(process, "env", {
    ...process.env, META_PIXEL_ID: "1234", META_PIXEL_ENABLED: "false", META_PIXEL_KILL_SWITCH_FILE: marker,
  });
  try {
    expect(await (await GET()).json()).toEqual({ pixelId: null });
    process.env.META_PIXEL_ENABLED = "true";
    const enabled = await GET();
    expect(enabled.headers.get("cache-control")).toBe("no-store");
    expect(await enabled.json()).toEqual({ pixelId: "1234" });
    await writeFile(marker, "");
    expect(await (await GET()).json()).toEqual({ pixelId: null });
    process.env.META_PIXEL_ID = "invalid";
    expect(await (await GET()).json()).toEqual({ pixelId: null });
  } finally {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true });
  }
});

test("loads the official library lazily, initializes once and emits only allowlisted events without parameters", async () => {
  const script = await readFile(join(__dirname, "../../public/meta-pixel-frame.js"), "utf8");
  const parent = { postMessage: jest.fn() };
  const append = jest.fn();
  const window = { parent, location: { origin: "https://fastque.test" }, addEventListener: jest.fn() };
  runInNewContext(script, { window, document: { createElement: () => ({}), head: { append } } });
  const [, onMessage] = window.addEventListener.mock.calls[0];
  const send = (data, origin = window.location.origin) => onMessage({ source: parent, origin, data });
  send({ type: "prepare" }, "https://unrelated.test");
  send({ type: "track", event: "PageView", pixelId: "1234" });
  expect(append).not.toHaveBeenCalled();
  send({ type: "prepare" });
  send({ type: "prepare" });
  expect(append).toHaveBeenCalledTimes(1);
  const [loader] = append.mock.calls[0];
  expect(loader.src).toBe("https://connect.facebook.net/en_US/fbevents.js");
  expect(window.fbq.disablePushState).toBe(true);
  const callMethod = jest.fn();
  window.fbq.callMethod = callMethod;
  loader.onload();
  expect(parent.postMessage).toHaveBeenCalledWith({ type: "fastque-pixel-ready", ready: true }, window.location.origin);
  send({ type: "track", event: "PageView", pixelId: "1234" });
  send({ type: "track", event: "Search", pixelId: "1234", searchString: "private" });
  send({ type: "revoke" });
  send({ type: "track", event: "Purchase", pixelId: "1234" });
  send({ type: "track", event: "Schedule", pixelId: "1234", bookingId: "private" });
  expect(callMethod.mock.calls).toEqual([
    ["consent", "grant"], ["set", "autoConfig", false, "1234"], ["init", "1234"],
    ["trackSingle", "1234", "PageView"], ["trackSingle", "1234", "Search"],
    ["consent", "revoke"], ["consent", "grant"], ["trackSingle", "1234", "Schedule"],
  ]);
});
