// Inventory Phase 1 — helpers for the Scan / Add stock screen. Pure, so they're testable without a
// camera: reading likely product details out of packaging text (from on-device OCR), and telling a
// USB/Bluetooth barcode scanner (which "types" the code very fast, then Enter) apart from a person.

import type { InventoryUnit } from "@barbercue/shared";

export interface PackagingGuess {
  name: string | null;
  brand: string | null;
  packSize: number | null;
  packUnit: InventoryUnit | null;
  mrp: number | null;
}

const UNIT_WORDS: Array<[RegExp, InventoryUnit]> = [
  [/^(ml|millilitres?|milliliters?)$/i, "MILLILITER"],
  [/^(l|ltr|litres?|liters?)$/i, "LITER"],
  [/^(g|gm|gms|grams?)$/i, "GRAM"],
  [/^(kg|kgs|kilograms?)$/i, "KILOGRAM"],
  [/^(pcs|pc|pieces?|nos?|units?)$/i, "EACH"],
];

const NOISE = /(ingredients|directions|how to use|manufactured|marketed|mfd|mfg|exp|best before|batch|lot|customer care|www\.|@|net\s*(wt|vol|qty)|mrp|incl|taxes|price)/i;

/**
 * Best guesses from packaging text. Only obvious, labelled values are taken (MRP after "MRP",
 * a number followed by a unit); name and brand are just the most prominent short lines, offered
 * as suggestions the person confirms — never saved on their own.
 */
export function parsePackagingText(text: string): PackagingGuess {
  const normalized = text.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)));
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2);

  let mrp: number | null = null;
  const mrpMatch = normalized.match(/M\.?\s*R\.?\s*P\.?[^0-9₹]{0,20}(?:₹|Rs\.?|INR)?\s*([0-9]{1,6}(?:[.,][0-9]{1,2})?)/i);
  if (mrpMatch) mrp = Number(mrpMatch[1].replace(",", "."));

  let packSize: number | null = null;
  let packUnit: InventoryUnit | null = null;
  const sizeMatch = normalized.match(/(\d{1,5}(?:[.,]\d{1,3})?)\s?(ml|millilitres?|milliliters?|ltr|litres?|liters?|l|gms?|grams?|g|kgs?|kilograms?|pcs|pieces?)\b/i);
  if (sizeMatch) {
    const unit = UNIT_WORDS.find(([pattern]) => pattern.test(sizeMatch[2]));
    if (unit) {
      packSize = Number(sizeMatch[1].replace(",", "."));
      packUnit = unit[1];
    }
  }

  const candidates = lines.filter((line) => !NOISE.test(line) && /[a-z]/i.test(line) && line.length <= 40 && !/^\d/.test(line));
  const brand = candidates[0] ?? null;
  const name = candidates.find((line) => line !== brand && line.split(" ").length >= 2) ?? candidates[1] ?? null;
  return { name, brand, packSize, packUnit, mrp: Number.isFinite(mrp ?? NaN) ? mrp : null };
}

/**
 * Recognises a hardware barcode scanner acting as a keyboard: characters arriving within
 * `gapMs` of each other, at least `minLength` of them, ending with Enter. People type far slower,
 * so normal typing never triggers it.
 */
export function createScannerKeyBuffer(onCode: (code: string) => void, { gapMs = 50, minLength = 6 } = {}) {
  let buffer = "";
  let last = 0;
  return (key: string, at: number): boolean => {
    if (at - last > gapMs) buffer = "";
    last = at;
    if (key === "Enter") {
      const code = buffer;
      buffer = "";
      if (code.length >= minLength) {
        onCode(code);
        return true;
      }
      return false;
    }
    if (key.length === 1) buffer += key;
    return false;
  };
}

/** Plain-language message for a camera failure (getUserMedia / ZXing errors). */
export function cameraErrorText(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera permission was turned off. Allow the camera for this site in your browser settings, or type the barcode below.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera was found on this device. Type the barcode below, use a USB scanner, or upload a photo of the barcode.";
  if (name === "NotReadableError")
    return "The camera is being used by another app. Close it and try again, or type the barcode below.";
  return "The camera could not start. Type the barcode below, or upload a photo of the barcode.";
}
