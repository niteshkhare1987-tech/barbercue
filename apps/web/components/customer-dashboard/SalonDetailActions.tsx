"use client";

import { useEffect } from "react";
import { Role } from "@barbercue/shared";
import { useAuth } from "../../lib/auth-context";
import { recordSalonView } from "../../lib/recently-viewed";
import type { ShareableSalon } from "../../lib/salon-share";
import { FavoriteButton } from "../discovery/FavoriteButton";
import { ShareSalonButton } from "./ShareSalonButton";

/**
 * Salon detail page: heart + share, and records ONE "recently viewed" entry per page visit once the
 * auth state is known (signed-in customers on their account, guests in this browser only).
 * Owners/staff/admins browsing the public page are not recorded.
 */
export function SalonDetailActions({ salon }: { salon: ShareableSalon & { id: string } }) {
  const { user, status } = useAuth();
  const isCustomer = status === "authenticated" && !!user?.roles.includes(Role.CUSTOMER);
  const isWorkspace = status === "authenticated" && !isCustomer;

  useEffect(() => {
    if (status === "loading" || isWorkspace) return;
    void recordSalonView(salon.id, isCustomer);
  }, [salon.id, status, isCustomer, isWorkspace]);

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "12px 0" }}>
      <FavoriteButton salonId={salon.id} salonName={salon.name} variant="inline" />
      <ShareSalonButton salon={salon} variant="text" />
    </div>
  );
}
