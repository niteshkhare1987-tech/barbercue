import { Role } from "@barbercue/shared";
import {
  addressPreview,
  draftPayload,
  hoursForSave,
  initialHours,
  liveMissing,
  newServiceRow,
  servicesPayload,
} from "../onboarding";
import { canOpenAdminPath } from "../admin-route-access";

describe("onboarding client helpers", () => {
  it("turns blank fields into null and never invents values", () => {
    const body = draftPayload({
      salonName: "Salon 17",
      postalCode: "",
      employeeCount: "",
      chairCount: "9",
      genderCategory: "",
      walkInsAccepted: "",
      bookingsAccepted: "true",
      consentContact: true,
      consentListing: "",
    });
    expect(body).toMatchObject({
      salonName: "Salon 17",
      postalCode: "",
      employeeCount: null,
      chairCount: 9,
      genderCategory: null,
      walkInsAccepted: null,
      bookingsAccepted: true,
      consentContact: true,
      consentListing: false,
    });
  });

  it("starts every weekday empty and only saves days the employee filled", () => {
    const hours = initialHours([]);
    expect(hours).toHaveLength(7);
    expect(hours.every((h) => h.opensAt === null && !h.isClosed)).toBe(true);
    hours[0] = { ...hours[0], opensAt: "09:00", closesAt: "21:00" };
    hours[6] = { ...hours[6], isClosed: true };
    expect(hoursForSave(hours)).toEqual([
      { dayOfWeek: 1, isClosed: false, opensAt: "09:00", closesAt: "21:00" },
      { dayOfWeek: 0, isClosed: true, opensAt: null, closesAt: null },
    ]);
  });

  it("drops empty service rows and keeps missing durations as null", () => {
    const rows = [newServiceRow({ serviceName: " Facial ", basePrice: 800 }), newServiceRow()];
    expect(servicesPayload(rows)).toEqual([
      expect.objectContaining({ serviceName: "Facial", basePrice: 800, durationMinutes: null, confirmedByEmployee: false }),
    ]);
  });

  it("previews the address from what was entered", () => {
    expect(addressPreview({ shopNumber: "UGF22", streetAddress: "Express Garden Market", locality: "Indirapuram", city: "Ghaziabad", postalCode: "201014", country: "India" }))
      .toBe("UGF22, Express Garden Market, Indirapuram, Ghaziabad · PIN 201014 · India");
  });

  it("reports the same missing items the server enforces (sample salon stays a draft)", () => {
    const missing = liveMissing(
      { salonName: "Salon 17 Professionals", ownerName: "Owner", ownerPhone: "9999221320", streetAddress: "Market", locality: "Indirapuram", city: "Ghaziabad", state: "UP", country: "India", employeeCount: 10, chairCount: 9 },
      initialHours([{ dayOfWeek: 1, isClosed: false, opensAt: "09:00", closesAt: "21:00", closesNextDay: false }]),
      [newServiceRow({ serviceName: "Facial", basePrice: 800 })],
      [],
      null,
    );
    const fields = missing.map((m) => m.field);
    expect(fields).toEqual(expect.arrayContaining(["postalCode", "genderCategory", "salonKind", "photos", "consent", "services"]));
    expect(missing.find((m) => m.message.includes("Duration"))).toBeTruthy();
  });
});

describe("admin onboarding route access", () => {
  it.each([
    [[Role.PLATFORM_ADMIN], true],
    [[Role.CO_FOUNDER], true],
    [[Role.SALES_ADMIN], true],
    [[Role.PLATFORM_VIEWER], true],
    [[Role.HR_ADMIN], false],
    [[Role.FIELD_EXECUTIVE], false],
    [[Role.SALON_OWNER], false],
  ])("roles %j -> %s", (roles, allowed) => {
    expect(canOpenAdminPath(roles, "/dashboard/admin/onboarding/abc")).toBe(allowed);
  });
});
