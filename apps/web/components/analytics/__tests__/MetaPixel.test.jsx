import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { MetaPixel } from "../MetaPixel";
import { advertisingPreference, suspendMetaPixel, trackMetaPixel } from "../../../lib/meta-pixel";

let mockPath = "/";
jest.mock("next/navigation", () => ({ usePathname: () => mockPath }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ children, href }) => <a href={href}>{children}</a> }));
jest.mock("../../../lib/meta-pixel", () => ({
  advertisingPreference: jest.fn(),
  getMetaPixelId: async () => "1234",
  isPixelPath: (path) => ["/", "/search"].includes(path),
  subscribeToAdvertisingPreference: () => () => {},
  suspendMetaPixel: jest.fn(),
  trackMetaPixel: jest.fn(),
}));

test("reports one page view per eligible SPA visit after consent", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  advertisingPreference.mockReturnValue("unset");
  let tree;
  await act(async () => { tree = TestRenderer.create(<MetaPixel />); });
  try {
    expect(trackMetaPixel).not.toHaveBeenCalled();
    advertisingPreference.mockReturnValue("allow");
    await act(async () => tree.update(<MetaPixel />));
    await act(async () => tree.update(<MetaPixel />));
    expect(trackMetaPixel.mock.calls).toEqual([["PageView"]]);
    mockPath = "/search";
    await act(async () => tree.update(<MetaPixel />));
    mockPath = "/dashboard/admin";
    await act(async () => tree.update(<MetaPixel />));
    expect(suspendMetaPixel).toHaveBeenCalled();
    expect(trackMetaPixel).toHaveBeenCalledTimes(2);
    mockPath = "/search";
    await act(async () => tree.update(<MetaPixel />));
    expect(trackMetaPixel).toHaveBeenCalledTimes(3);
    advertisingPreference.mockReturnValue("deny");
    await act(async () => tree.update(<MetaPixel />));
    advertisingPreference.mockReturnValue("allow");
    await act(async () => tree.update(<MetaPixel />));
    expect(trackMetaPixel).toHaveBeenCalledTimes(3);
    advertisingPreference.mockReturnValue("deny");
    mockPath = "/";
    await act(async () => tree.update(<MetaPixel />));
    expect(trackMetaPixel).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => tree.unmount());
  }
});
