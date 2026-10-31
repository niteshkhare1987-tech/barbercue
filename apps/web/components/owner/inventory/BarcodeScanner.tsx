"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cameraErrorText, createScannerKeyBuffer } from "../../../lib/product-scan";
import { Banner, Btn } from "../parts";
import ui from "../owner.module.css";
import styles from "./scan.module.css";

type Hint = "UPC_E" | undefined;
type Controls = { stop: () => void };

/**
 * Browser barcode scanner for phones (Android, iPhone Safari), laptop webcams and USB/Bluetooth
 * scanners — no app needed. Uses ZXing (open source, loaded only when the camera starts). Prefers
 * the rear camera, can switch cameras, beeps/vibrates on a read, ignores the same code while it is
 * being handled, and always stops the camera when scanning ends or the screen closes. Manual entry
 * and "photo of a barcode" work without any camera. Camera access needs HTTPS (or localhost).
 */
export function BarcodeScanner({ onDetected, busy }: { onDetected: (code: string, hint: Hint) => void; busy: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<Controls | null>(null);
  const lastRef = useRef<{ code: string; at: number } | null>(null);
  const busyRef = useRef(busy);
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceIndex, setDeviceIndex] = useState<number | null>(null);
  const [manual, setManual] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const confirmRead = useCallback(() => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        osc.frequency.value = 1200;
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.08);
        osc.onended = () => void ctx.close();
      }
    } catch {
      /* sound is a nicety */
    }
    navigator.vibrate?.(60);
  }, []);

  /** One place every input (camera, photo, USB scanner, typing) goes through. */
  const handle = useCallback(
    (raw: string, hint: Hint, fromCamera: boolean) => {
      const code = raw.trim();
      if (!code || busyRef.current) return;
      const now = Date.now();
      if (fromCamera && lastRef.current && lastRef.current.code === code && now - lastRef.current.at < 3000) return;
      lastRef.current = { code, at: now };
      if (fromCamera) confirmRead();
      setFlash(code);
      onDetected(code, hint);
    },
    [confirmRead, onDetected],
  );

  const stop = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setPhase("idle");
  }, []);

  const start = useCallback(
    async (index: number | null) => {
      setError(null);
      if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setPhase("error");
        setError(window.isSecureContext === false ? "The camera only works on a secure (https) page. Type the barcode below instead." : "This browser can't use the camera. Type the barcode below, or upload a photo of it.");
        return;
      }
      setPhase("starting");
      controlsRef.current?.stop();
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
        ]);
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
        const chosen = index !== null ? devices[index] : undefined;
        const video: MediaTrackConstraints = chosen
          ? { deviceId: { exact: chosen.deviceId } }
          : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } };
        controlsRef.current = await reader.decodeFromConstraints({ video, audio: false }, videoRef.current!, (result) => {
          if (result) handle(result.getText(), result.getBarcodeFormat() === BarcodeFormat.UPC_E ? "UPC_E" : undefined, true);
        });
        setPhase("live");
        // Camera names are only readable after permission was granted.
        const list = await BrowserMultiFormatReader.listVideoInputDevices().catch(() => []);
        setDevices(list);
      } catch (err) {
        setPhase("error");
        setError(cameraErrorText(err));
      }
    },
    [devices, handle],
  );

  // Always release the camera when leaving the screen.
  useEffect(() => () => stop(), [stop]);

  // USB/Bluetooth scanners type the code very fast and press Enter.
  useEffect(() => {
    const feed = createScannerKeyBuffer((code) => handle(code, undefined, false));
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (feed(event.key, event.timeStamp)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handle]);

  async function fromPhoto(file: File | undefined) {
    if (!file) return;
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      handle(result.getText(), result.getBarcodeFormat() === BarcodeFormat.UPC_E ? "UPC_E" : undefined, false);
    } catch {
      setError("No barcode could be read from that photo. Try a sharper, closer photo with the whole barcode in view, or type the number.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const switchCamera = () => {
    if (devices.length < 2) return;
    const next = ((deviceIndex ?? devices.findIndex((d) => /back|rear|environment/i.test(d.label))) + 1) % devices.length;
    setDeviceIndex(next);
    void start(next);
  };

  return (
    <div className={styles.scanner}>
      <div className={`${styles.viewport} ${phase === "live" ? styles.viewportLive : ""}`}>
        <video ref={videoRef} className={styles.video} muted playsInline aria-label="Camera preview for scanning barcodes" />
        {phase === "live" && <div className={styles.guide} aria-hidden="true" />}
        {phase !== "live" && (
          <div className={styles.placeholder}>
            <span aria-hidden="true">▥</span>
            <p>{phase === "starting" ? "Starting the camera…" : "Point the camera at the product's barcode."}</p>
          </div>
        )}
      </div>

      <div className={`${ui.rowWrap} ${ui.mt12}`}>
        {phase === "live" ? (
          <>
            <Btn onClick={stop}>Stop camera</Btn>
            {devices.length > 1 && <Btn variant="quiet" onClick={switchCamera}>Switch camera</Btn>}
          </>
        ) : (
          <Btn variant="primary" onClick={() => void start(deviceIndex)} disabled={phase === "starting"}>
            {phase === "starting" ? "Starting…" : "Scan with camera"}
          </Btn>
        )}
        <label className={styles.photoButton}>
          Photo of a barcode
          <input type="file" accept="image/*" capture="environment" onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
      </div>

      {error && <div className={ui.mt12}><Banner tone="warn">{error}</Banner></div>}

      <form
        className={`${ui.rowWrap} ${ui.mt12}`}
        onSubmit={(e) => {
          e.preventDefault();
          handle(manual, undefined, false);
        }}
      >
        <label className={styles.manual}>
          <span className={ui.label}>Or type the barcode</span>
          <input className={ui.input} inputMode="numeric" autoComplete="off" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="e.g. 8901234567890" />
        </label>
        <Btn type="submit" disabled={busy || !manual.trim()}>Look up</Btn>
      </form>
      <p className={ui.hint} role="status" aria-live="polite">
        {busy ? "Looking up…" : flash ? `Last read: ${flash}` : "A plugged-in barcode scanner works too — just scan."}
      </p>
    </div>
  );
}
