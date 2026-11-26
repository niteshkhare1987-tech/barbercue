"use client";

import { useState } from "react";
import { DASHBOARD_PATHS, SALON_PHOTO_UPLOAD, updateSalonStaffSchema } from "@barbercue/shared";
import type { SalonStaffDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { Button } from "../ui/Button";
import styles from "./dashboard.module.css";

/**
 * Phase 17 (Barber Professional Profile) — owner-editable bio/photo/experience for one barber,
 * shown to customers on the salon's public profile ("Meet the team") and the booking flow's
 * barber picker. Submits directly against the member the parent list already holds (no separate
 * GET) since PATCH dashboard/salons/:salonId/staff/:staffId already returns the full SalonStaffDto.
 */
export function StaffProfileEditor({
  salonId,
  member,
  onSaved,
  onPhotoSaved,
}: {
  salonId: string;
  member: SalonStaffDto;
  onSaved: (updated: SalonStaffDto) => void;
  onPhotoSaved: (photoUrl: string) => void;
}) {
  const base = `${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.salons}/${salonId}/${DASHBOARD_PATHS.staff}/${member.id}`;
  const [bio, setBio] = useState(member.bio ?? "");
  const [photoUrl, setPhotoUrl] = useState(member.photoUrl ?? "");
  const [yearsExperience, setYearsExperience] = useState(
    member.yearsExperience !== null ? String(member.yearsExperience) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [photoNotice, setPhotoNotice] = useState("");

  async function uploadPortrait(file: File) {
    setError(null);
    setPhotoNotice("");
    if (file.size > SALON_PHOTO_UPLOAD.maxBytes) {
      setError("Choose a smaller barber photo.");
      return;
    }
    const body = new FormData();
    body.append("image", file);
    setUploading(true);
    try {
      const result = await apiFetch<{ photoUrl: string }>(
        `${base}/photo/${DASHBOARD_PATHS.photoUpload}`,
        { method: "POST", body },
      );
      setPhotoUrl(result.photoUrl);
      onPhotoSaved(result.photoUrl);
      setPhotoNotice("Barber photo saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload the barber photo.");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    setError(null);
    const parsed = updateSalonStaffSchema.safeParse({
      bio,
      ...(photoUrl !== (member.photoUrl ?? "") ? { photoUrl } : {}),
      ...(yearsExperience.trim() ? { yearsExperience: Number(yearsExperience) } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the profile details.");
      return;
    }
    setSaving(true);
    try {
      const updated = await apiFetch<SalonStaffDto>(base, {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--bc-border)" }}>
      {error && <p role="alert" className={`${styles.banner} ${styles.bannerError}`}>{error}</p>}
      <div className={styles.fieldWrap} style={{ marginBottom: 10 }}>
        <label className={styles.fieldLabel} htmlFor={`bio-${member.id}`}>Skills description (optional)</label>
        <textarea
          id={`bio-${member.id}`}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="e.g. Specializes in skin fades, beard shaping, and textured cuts."
          className={styles.input}
        />
      </div>
      <div className={styles.fieldWrap} style={{ marginBottom: 10 }}>
        <label className={styles.fieldLabel} htmlFor={`portrait-${member.id}`}>Barber photo (optional)</label>
        <input
          id={`portrait-${member.id}`}
          className={styles.input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={uploading || saving}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void uploadPortrait(file);
          }}
        />
        <p className={styles.hint}>Uploads save immediately and can appear on your public shop profile. Upload with the barber’s permission.</p>
        {(uploading || photoNotice) && <p role="status" className={styles.hint}>{uploading ? "Uploading photo…" : photoNotice}</p>}
        <label className={styles.fieldLabel} htmlFor={`photo-${member.id}`}>Photo URL</label>
        <input
          id={`photo-${member.id}`}
          type="url"
          disabled={uploading || saving}
          value={photoUrl}
          onChange={(e) => setPhotoUrl(e.target.value)}
          placeholder="https://…"
          className={styles.input}
        />
        <p className={styles.hint}>You can also enter a direct HTTPS image link. Clear the link and save to remove the photo from the profile.</p>
      </div>
      <div className={styles.fieldWrap} style={{ marginBottom: 10, maxWidth: 200 }}>
        <label className={styles.fieldLabel} htmlFor={`years-${member.id}`}>Years of experience</label>
        <input
          id={`years-${member.id}`}
          type="number"
          min={0}
          max={80}
          value={yearsExperience}
          onChange={(e) => setYearsExperience(e.target.value)}
          className={styles.input}
        />
      </div>
      <Button type="button" variant="outline" onClick={() => void handleSave()} disabled={saving || uploading}>
        {saving ? "Saving…" : "Save profile"}
      </Button>
    </div>
  );
}
