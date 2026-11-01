"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cameraErrorText, codeFromScan, createScannerKeyBuffer } from "../../../lib/product-scan";
import { Banner, Btn } from "../parts";
import ui from "../owner.module.css";
import styles from "./scan.module.css";

type Hint = "UPC_E" | undefined;
type ZxingLibrary = typeof import("@zxing/library");

/** After this long live without a read, show tips for holding the product. */
const SCAN_TIP_AFTER_MS = 6000;

/** Product barcodes plus QR / Data Matrix; TRY_HARDER keeps reading slightly blurred or tilted webcam frames. */
function scanHints(BarcodeFormat: ZxingLibrary["BarcodeFormat"], DecodeHintType: ZxingLibrary["DecodeHintType"]) {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
    BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return hints;
}
type Controls = { stop: () => void };

/**
 * Browser barcode / QR scanner for phones (Android, iPhone Safari), laptop webcams and USB/Bluetooth
 * scanners — no app needed. Uses ZXing (open source, loaded only when the camera starts). Prefers
 * the rear camera, can switch cameras, beeps/vibrates on a read, ignores the same code while it is
 * being handled, and always stops the camera when scanning ends or the screen closes. Manual entry
 * and "photo of a barcode" work without any camera. Camera access needs HTTPS (or localhost).
 */
export function BarcodeScanner({ onDetected, busy }: { onDetected: (code: string, hint: Hint) => void; busy: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<Controls | null>(null);
  /** Bumped on every start/stop, so a camera that finishes starting after a stop is shut again. */
  const sessionRef = useRef(0);
  const lastRef = useRef<{ code: string; at: number } | null>(null);
  const busyRef = useRef(busy);
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceIndex, setDeviceIndex] = useState<number | null>(null);
  const [manual, setManual] = useState("");
  const [shortOk, setShortOk] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [tipFor, setTipFor] = useState<string | null>(null);

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

  const stop = useCallback(() => {
    sessionRef.current += 1;
    controlsRef.current?.stop();
    controlsRef.current = null;
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setPhase("idle");
  }, []);

  /** One place every input (camera, photo, USB scanner, typing) goes through. */
  const handle = useCallback(
    (raw: string, hint: Hint, fromCamera: boolean) => {
      const read = raw.trim();
      if (!read || busyRef.current) return;
      const now = Date.now();
      if (fromCamera && lastRef.current && lastRef.current.code === read && now - lastRef.current.at < 3000) return;
      lastRef.current = { code: read, at: now };
      if (fromCamera) confirmRead();
      const scanned = codeFromScan(read);
      if (!scanned.ok) {
        setError(scanned.reason);
        return;
      }
      setError(null);
      setFlash(scanned.code);
      // One product at a time: stop so holding the pack in view doesn't keep re-reading it.
      if (fromCamera) stop();
      onDetected(scanned.code, hint);
    },
    [confirmRead, onDetected, stop],
  );

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
      const session = ++sessionRef.current;
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
        const reader = new BrowserMultiFormatReader(scanHints(BarcodeFormat, DecodeHintType), { delayBetweenScanAttempts: 150 });
        const chosen = index !== null ? devices[index] : undefined;
        const video: MediaTrackConstraints = chosen
          ? { deviceId: { exact: chosen.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } };
        const controls = await reader.decodeFromConstraints({ video, audio: false }, videoRef.current!, (result) => {
          if (result && sessionRef.current === session) handle(result.getText(), result.getBarcodeFormat() === BarcodeFormat.UPC_E ? "UPC_E" : undefined, true);
        });
        if (sessionRef.current !== session) {
          // Stopped (e.g. the first frame was already read) while the camera was still starting.
          controls.stop();
          stop();
          return;
        }
        controlsRef.current = controls;
        setPhase("live");
        // Continuous autofocus where the camera supports it (many laptop webcams are fixed-focus).
        const [track] = ((videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks() ?? []);
        void track?.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
        // Camera names are only readable after permission was granted.
        const list = await BrowserMultiFormatReader.listVideoInputDevices().catch(() => []);
        setDevices(list);
      } catch (err) {
        setPhase("error");
        setError(cameraErrorText(err));
      }
    },
    [devices, handle, stop],
  );

  // Live for a while with nothing read: most often the barcode is too close for the camera to focus.
  const tipKey = `${phase}:${flash ?? ""}`;
  useEffect(() => {
    if (phase !== "live") return;
    const timer = setTimeout(() => setTipFor(tipKey), SCAN_TIP_AFTER_MS);
    return () => clearTimeout(timer);
  }, [phase, tipKey]);
  const showTip = phase === "live" && tipFor === tipKey;

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
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
      const result = await new BrowserMultiFormatReader(scanHints(BarcodeFormat, DecodeHintType)).decodeFromImageUrl(url);
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
            <p>{phase === "starting" ? "Starting the camera…" : "Point the camera at the product's barcode or QR code."}</p>
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
            {phase === "starting" ? "Starting…" : flash ? "Scan another" : "Scan with camera"}
          </Btn>
        )}
        <label className={styles.photoButton}>
          Photo of a barcode
          <input type="file" accept="image/*" capture="environment" onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
      </div>

      {error && <div className={ui.mt12}><Banner tone="warn">{error}</Banner></div>}
      {showTip && !error && (
        <div className={ui.mt12}>
          <Banner tone="info">
            Not reading yet? Hold the barcode flat, in good light, with its lines across the screen. Move it slowly further away
            until it looks sharp — laptop cameras can&apos;t focus very close. Or use &quot;Photo of a barcode&quot;, or type the number.
          </Banner>
        </div>
      )}

      <form
        className={`${ui.rowWrap} ${ui.mt12}`}
        onSubmit={(e) => {
          e.preventDefault();
          // People often type only the big printed digits and miss the small ones at each end.
          const digits = manual.replace(/[\s-]/g, "");
          if (/^\d{9,11}$/.test(digits) && shortOk !== digits) {
            setShortOk(digits);
            setError(`That's ${digits.length} digits. Pack barcodes are usually 12 or 13 digits — include the small digits printed at each end. Press Look up again to use it as typed.`);
            return;
          }
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
