import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { EmployeeOnboardingTab } from "../EmployeeOnboardingTab";
import { OnboardingWizard } from "../OnboardingWizard";
import { apiFetch } from "../../../lib/api";

jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children, ...rest }) => <a href={href} {...rest}>{children}</a> }));
jest.mock("../PrivateImage", () => ({ PrivateImage: ({ alt }) => <span data-testid="private-image">{alt}</span> }));
jest.mock("../../../lib/api", () => {
  class MockApiError extends Error {
    constructor(status, body) {
      super(body?.error?.message ?? "Request failed");
      this.status = status;
      this.details = body?.error?.details;
    }
  }
  return { apiFetch: jest.fn(), apiFetchBlob: jest.fn(), ApiError: MockApiError };
});

const collect = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collect).join(" ");
  return collect(node.children);
};
const text = (r) => collect(r.toJSON()).replace(/\s+/g, " ");
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

const COUNTS = { drafts: 2, pending: 1, changes: 1, approved: 0, activated: 3, rejected: 0 };
const ITEM = {
  id: "a1", reference: "FQ-ONB-2026-000001", salonName: "Salon 17 Professionals", city: "Ghaziabad", locality: "Indirapuram",
  ownerName: "Owner", ownerPhone: "+919999221320", employee: { id: "e1", fullName: "Field A", employeeCode: "FQ-1" }, reviewer: null,
  status: "DRAFT", submittedAt: null, updatedAt: "2026-11-01T05:00:00.000Z", serviceCount: 9, photoCount: 0, missingCount: 6,
};

function baseApp(overrides = {}) {
  return {
    id: "a1", reference: "FQ-ONB-2026-000001", version: 3, status: "SUBMITTED", leadId: "l1", salonId: null, salonPublicId: null,
    assignedEmployee: { id: "e1", fullName: "Field A", employeeCode: "FQ-1" }, territory: null, reviewer: null, canEdit: false,
    salonName: "Salon 17 Professionals", genderCategory: null, salonKind: null, description: null, brandName: null, websiteUrl: null,
    instagramUrl: null, mapsUrl: null, isFranchise: null, branchCount: null, ownerName: "Owner", ownerPhone: "+919999221320",
    ownerWhatsapp: null, ownerEmail: null, alternatePhone: null, managerName: null, managerPhone: null, preferredLanguage: null,
    shopNumber: null, buildingName: null, streetAddress: null, locality: null, city: null, district: null, state: null, postalCode: null,
    country: null, landmark: null, coordinates: null, employeeCount: null, chairCount: null, activeChairCount: null, maleStaffCount: null,
    femaleStaffCount: null, walkInsAccepted: null, bookingsAccepted: null, liveQueueSupported: null, appointmentIntervalMinutes: null,
    averageServiceMinutes: null, specialTimings: null, hours: [], consentContact: false, consentListing: false, consentAccuracy: false,
    consentAuthorization: false, consentCapturedAt: null, gstin: null, businessRegistration: null, employeeNotes: null, openQuestions: null,
    services: [], media: [], missing: [], changeRequest: null, rejectionReason: null, photoExceptionReason: null, firstSubmittedAt: null,
    submittedAt: null, approvedAt: null, rejectedAt: null, publishAuthorizedAt: null, publishedAt: null,
    createdAt: "2026-11-01T05:00:00.000Z", updatedAt: "2026-11-01T05:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
});

describe("EmployeeOnboardingTab", () => {
  it("shows a count beside every category and lists the employee's drafts", async () => {
    apiFetch.mockImplementation((path) => {
      if (path.endsWith("/counts")) return Promise.resolve(COUNTS);
      if (path.endsWith("/analytics")) return Promise.reject(new Error("no analytics"));
      return Promise.resolve([ITEM]);
    });
    let r;
    await act(async () => { r = TestRenderer.create(<EmployeeOnboardingTab />); });
    await flush();
    const body = text(r);
    for (const label of ["My Drafts 2", "Pending Review 1", "Changes Requested 1", "Approved 0", "Activated 3", "Rejected 0"]) {
      expect(body).toContain(label);
    }
    expect(body).toContain("FQ-ONB-2026-000001");
    expect(body).toContain("6 to complete");
    expect(apiFetch).toHaveBeenCalledWith("employee/onboarding?bucket=drafts");
  });
});

describe("OnboardingWizard", () => {
  it("is read-only after submission and offers no submit action", async () => {
    apiFetch.mockResolvedValue(baseApp());
    let r;
    await act(async () => { r = TestRenderer.create(<OnboardingWizard applicationId="a1" />); });
    await flush();
    expect(text(r)).toContain("read-only");
    const buttons = r.root.findAllByType("button").map((b) => collect(b.props.children));
    expect(buttons.some((b) => b.includes("Submit for review"))).toBe(false);
    expect(buttons.some((b) => b.includes("Save draft"))).toBe(false);
    const inputs = r.root.findAllByType("input");
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => i.props.disabled)).toBe(true);
  });

  it("shows the admin's correction list when changes are requested", async () => {
    apiFetch.mockResolvedValue(
      baseApp({ status: "CHANGES_REQUESTED", canEdit: true, changeRequest: [{ field: "postalCode", message: "PIN does not match" }] }),
    );
    let r;
    await act(async () => { r = TestRenderer.create(<OnboardingWizard applicationId="a1" />); });
    await flush();
    expect(text(r).replace(/ :/g, ":")).toContain("PIN code: PIN does not match");
  });

  it("keeps submit disabled while required details are missing", async () => {
    apiFetch.mockResolvedValue(baseApp({ status: "DRAFT", canEdit: true }));
    let r;
    await act(async () => { r = TestRenderer.create(<OnboardingWizard applicationId="a1" />); });
    await flush();
    const reviewStep = r.root.findAllByType("button").find((b) => collect(b.props.children).includes("Review & submit"));
    await act(async () => { reviewStep.props.onClick(); });
    await flush();
    expect(text(r)).toContain("Still missing before you can submit");
    const submit = r.root.findAllByType("button").find((b) => collect(b.props.children).includes("Submit for review"));
    expect(submit.props.disabled).toBe(true);
  });
});
