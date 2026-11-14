import { Role } from "@barbercue/shared";
import { chooseShopHome, shopHomePath } from "../shop-home";
import { forgetLastShop, readLastShop, rememberLastShop } from "../last-shop";
import { ownerHomePath, workspaceLandingPath } from "../workspace-route";

// Owner requirement: after sign-in an owner lands in THEIR shop's dashboard home - not on a shop list,
// not on the public site - and the remembered shop is only ever a hint checked against the server.

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

describe("chooseShopHome", () => {
  const shops = (...ids) => ids.map((id) => ({ id }));

  it("sends a single-shop owner straight to their shop, remembered or not", () => {
    expect(chooseShopHome(shops("a"), null)).toBe("a");
    expect(chooseShopHome(shops("a"), "zzz")).toBe("a");
  });

  it("restores the last shop for a multi-shop owner when the server still lists it", () => {
    expect(chooseShopHome(shops("a", "b", "c"), "b")).toBe("b");
  });

  it("shows the picker (null) when the remembered shop is gone or was never set", () => {
    expect(chooseShopHome(shops("a", "b"), null)).toBeNull();
    expect(chooseShopHome(shops("a", "b"), "removed-shop")).toBeNull();
  });

  it("never invents a shop for someone who has none (the registration / invitation path stays)", () => {
    expect(chooseShopHome([], "a")).toBeNull();
    expect(chooseShopHome([], null)).toBeNull();
  });

  it("never picks a shop that is not in the authorised list, whatever was remembered", () => {
    expect(chooseShopHome(shops("a", "b"), "someone-elses-shop")).toBeNull();
  });

  it("builds the shop home path", () => {
    expect(shopHomePath("s1")).toBe("/dashboard/salons/s1");
  });
});

describe("last shop memory", () => {
  beforeEach(() => {
    globalThis.window = { localStorage: fakeStorage() };
  });
  afterEach(() => {
    delete globalThis.window;
  });

  it("is remembered per account", () => {
    rememberLastShop("u1", "s1");
    expect(readLastShop("u1")).toBe("s1");
    expect(readLastShop("u2")).toBeNull();
  });

  it("is replaced by the next shop and can be forgotten", () => {
    rememberLastShop("u1", "s1");
    rememberLastShop("u1", "s2");
    expect(readLastShop("u1")).toBe("s2");
    forgetLastShop();
    expect(readLastShop("u1")).toBeNull();
  });

  it("ignores garbage and tolerates blocked storage", () => {
    window.localStorage.setItem("fastque.owner.lastShop.v1", "not json");
    expect(readLastShop("u1")).toBeNull();
    window.localStorage.setItem("fastque.owner.lastShop.v1", JSON.stringify({ u: "u1", s: 42 }));
    expect(readLastShop("u1")).toBeNull();
    globalThis.window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    };
    expect(() => rememberLastShop("u1", "s1")).not.toThrow();
    expect(readLastShop("u1")).toBeNull();
    expect(() => forgetLastShop()).not.toThrow();
  });

  it("is simply absent on the server", () => {
    delete globalThis.window;
    expect(readLastShop("u1")).toBeNull();
  });
});

describe("workspace landing for owners and barbers", () => {
  beforeEach(() => {
    globalThis.window = { localStorage: fakeStorage() };
  });
  afterEach(() => {
    delete globalThis.window;
  });
  const owner = { id: "u1", roles: [Role.SALON_OWNER] };
  const barber = { id: "u2", roles: [Role.SALON_STAFF] };

  it("without a remembered shop an owner or barber goes to the page that picks their shop (never the public site)", () => {
    expect(workspaceLandingPath(owner)).toBe("/dashboard/salons");
    expect(workspaceLandingPath(barber)).toBe("/dashboard/salons");
    expect(ownerHomePath(owner)).toBe("/dashboard/salons");
  });

  it("with a remembered shop the 'Owner dashboard' link opens that shop's home directly", () => {
    rememberLastShop("u1", "shop-9");
    expect(workspaceLandingPath(owner)).toBe("/dashboard/salons/shop-9");
    expect(ownerHomePath(owner)).toBe("/dashboard/salons/shop-9");
  });

  it("another account's remembered shop is never used", () => {
    rememberLastShop("u1", "shop-9");
    expect(workspaceLandingPath(barber)).toBe("/dashboard/salons");
  });

  it("does not change where admins, field executives and customers land", () => {
    rememberLastShop("u1", "shop-9");
    expect(workspaceLandingPath({ id: "a", roles: [Role.PLATFORM_ADMIN] })).toBe("/dashboard/admin");
    expect(workspaceLandingPath({ id: "e", roles: [Role.FIELD_EXECUTIVE] })).toBe("/employee");
    expect(workspaceLandingPath({ id: "c", roles: [Role.CUSTOMER] })).toBe("/account");
  });
});
