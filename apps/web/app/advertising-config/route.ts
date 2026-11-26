import { access } from "node:fs/promises";

async function disabledByMarker() {
  const path = process.env.META_PIXEL_KILL_SWITCH_FILE?.trim();
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch (error) {
    // An absent marker permits tracking. Other filesystem failures fail closed.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export async function GET() {
  const id = process.env.META_PIXEL_ID?.trim();
  const enabled = process.env.META_PIXEL_ENABLED === "true" && id && /^\d{1,20}$/.test(id);
  return Response.json(
    { pixelId: enabled && !await disabledByMarker() ? id : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
