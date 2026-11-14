// Customer phone sign-in on the login page (requirement #26/#30, FASTQUE_PHONE_OTP_V1): the phone form is offered only when the
// server says phone OTP is on, and Google and the rest of the page never depend on it.
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import CustomerLoginPage from "../page";
import { apiFetch } from "../../../../lib/api";
import { useAuth } from "../../../../lib/auth-context";

const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => ({ get: () => null }),
}));
jest.mock("../../../../components/auth/GoogleIdentityButton", () => ({ GoogleIdentityButton: () => <div>google-sign-in</div> }));
jest.mock("../../../../components/auth/CustomerAuthCard", () => ({ CustomerAuthCard: ({ children }) => <div>{children}</div> }));
jest.mock("../../../../components/auth/AuthCard", () => ({ AuthPageFallback: () => <div>fallback</div> }));
jest.mock("../../../../lib/auth-context", () => ({ useAuth: jest.fn() }));
jest.mock("../../../../lib/api", () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {},
}));

const { ApiError } = jest.requireMock("../../../../lib/api");
const PHONE = "+919876543210";

const collect = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collect).join(" ");
  return collect(node.children);
};
const text = (r) => collect(r.toJSON());
const byId = (r, id) => r.root.findAll((n) => typeof n.type === "string" && n.props.id === id)[0];
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

async function mount(methods, verifyCustomerOtp = jest.fn()) {
  useAuth.mockReturnValue({ verifyCustomerOtp, googleLogin: jest.fn() });
  apiFetch.mockImplementation(async (path) => {
    if (path.startsWith("auth/methods")) {
      if (methods instanceof Error) throw methods;
      return methods;
    }
    return { expiresInSeconds: 300 };
  });
  let r;
  await act(async () => { r = TestRenderer.create(<CustomerLoginPage />); });
  await flush();
  return r;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
});

describe("phone availability", () => {
  it("offers the phone form when the server says phone OTP is on", async () => {
    const r = await mount({ google: true, phoneOtp: true, ownerPhoneOtp: false });
    expect(byId(r, "customer-phone")).toBeDefined();
    expect(text(r)).toContain("google-sign-in");
    await act(async () => r.unmount());
  });

  it.each([
    ["phone OTP off", { google: true, phoneOtp: false }],
    ["no phoneOtp field", { google: true }],
    ["a value that is not exactly true", { phoneOtp: "yes" }],
    ["the capability check failing", new Error("offline")],
  ])("shows the unavailable notice and no phone form for %s, with Google still offered", async (_name, methods) => {
    const r = await mount(methods);
    expect(byId(r, "customer-phone")).toBeUndefined();
    expect(text(r)).toContain("Phone sign-in is temporarily unavailable");
    expect(text(r)).toContain("google-sign-in");
    await act(async () => r.unmount());
  });
});

describe("the one-time code step", () => {
  const submit = async (r, id, value) => {
    await act(async () => { byId(r, id).props.onChange({ target: { value } }); });
    await act(async () => { await r.root.findByType("form").props.onSubmit({ preventDefault: jest.fn() }); });
  };

  it("asks for the code without promising instant delivery, signs in and goes to the account", async () => {
    const verifyCustomerOtp = jest.fn().mockResolvedValue({ id: "c1", roles: ["CUSTOMER"] });
    const r = await mount({ phoneOtp: true }, verifyCustomerOtp);
    await submit(r, "customer-phone", PHONE);
    expect(apiFetch).toHaveBeenCalledWith("auth/otp/request", expect.objectContaining({ method: "POST", body: JSON.stringify({ phone: PHONE }) }));
    expect(text(r)).toContain("SMS delivery may take a moment");
    await submit(r, "customer-otp", "012345");
    expect(verifyCustomerOtp).toHaveBeenCalledWith({ phone: PHONE, code: "012345" });
    expect(replace).toHaveBeenCalledWith("/account");
    await act(async () => r.unmount());
  });

  it("does not claim a new code was sent, and keeps Resend off during the cooldown", async () => {
    const r = await mount({ phoneOtp: true });
    await submit(r, "customer-phone", PHONE);
    const resend = r.root.findAllByType("button").find((b) => /Resend OTP/.test(collect(b.props.children)));
    expect(collect(resend.props.children)).toMatch(/Resend OTP in \d+s/);
    expect(resend.props.disabled).toBe(true);
    await act(async () => r.unmount());
  });

  it("shows the server's refusal, for example a rate limit, and stays on the phone step", async () => {
    const r = await mount({ phoneOtp: true });
    apiFetch.mockImplementation(async (path) => {
      if (path.startsWith("auth/otp/request")) throw new ApiError("Too many codes requested. Try again later.");
      return { phoneOtp: true };
    });
    await submit(r, "customer-phone", PHONE);
    expect(text(r)).toContain("Too many codes requested. Try again later.");
    expect(byId(r, "customer-otp")).toBeUndefined();
    await act(async () => r.unmount());
  });

  it("does not call the server for a malformed number", async () => {
    const r = await mount({ phoneOtp: true });
    const before = apiFetch.mock.calls.length;
    await submit(r, "customer-phone", "12345");
    expect(apiFetch.mock.calls.length).toBe(before);
    expect(r.root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
    await act(async () => r.unmount());
  });
});
