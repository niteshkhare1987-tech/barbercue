"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DISCOVERY_PATHS } from "@barbercue/shared";
import type { ServiceSuggestionDto } from "@barbercue/shared";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api/v1";
const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 8;

type SuggestState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | { kind: "results"; query: string; services: ServiceSuggestionDto[] }
  | { kind: "failed"; query: string };

/**
 * Public Service NAME picker for /search. Suggests real active service names; the serviceName
 * filter then keeps salons offering that service or an equivalent name (see
 * expandServiceNameSearch). Enter without selecting still searches the typed text.
 */
export function ServiceNameSearchField({
  value,
  onChange,
  onSubmit,
  labelledBy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (serviceName?: string) => void;
  labelledBy: string;
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);
  const [state, setState] = useState<SuggestState>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmed = value.trim();
  const tooShort = trimmed.length < MIN_QUERY_LENGTH;

  useEffect(() => {
    // Jest's server-side renderer has no document; the outside-click listener is browser-only.
    if (!open || typeof document === "undefined") return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (tooShort || !open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const seq = ++requestSeqRef.current;
      setState({ kind: "loading", query: trimmed });
      const params = new URLSearchParams({ q: trimmed, limit: String(RESULT_LIMIT) });
      fetch(API_BASE_URL + "/" + DISCOVERY_PATHS.salons + "/" + DISCOVERY_PATHS.serviceSuggestions + "?" + params.toString())
        .then((response) => {
          if (!response.ok) throw new Error("Service suggestions unavailable");
          return response.json() as Promise<ServiceSuggestionDto[]>;
        })
        .then((data) => {
          if (cancelled || seq !== requestSeqRef.current) return;
          setActiveIndex(0);
          setState({ kind: "results", query: trimmed, services: data });
        })
        .catch(() => {
          if (cancelled || seq !== requestSeqRef.current) return;
          setState({ kind: "failed", query: trimmed });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, tooShort, open]);

  const services = !tooShort && state.kind === "results" && state.query === trimmed ? state.services : [];
  const expanded = open && services.length > 0;

  function choose(service: ServiceSuggestionDto) {
    setOpen(false);
    onChange(service.name);
    onSubmit(service.name);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (open) event.preventDefault();
      setOpen(false);
    } else if (expanded && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % services.length);
    } else if (expanded && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + services.length) % services.length);
    } else if (expanded && event.key === "Enter") {
      // Prevent the enclosing search form submitting a different free-text query.
      event.preventDefault();
      choose(services[activeIndex] ?? services[0]);
    }
  }

  const hintColor = "var(--fq-text-muted, #ddd)";
  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <input
        type="search"
        value={value}
        autoComplete="off"
        placeholder="Type a service name…"
        aria-labelledby={labelledBy}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={expanded}
        aria-activedescendant={expanded ? listboxId + "-" + activeIndex : undefined}
        onChange={(event) => {
          requestSeqRef.current += 1;
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />

      {expanded && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Matching services"
          style={{
            position: "absolute",
            zIndex: 30,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            margin: 0,
            padding: 4,
            listStyle: "none",
            background: "#fff",
            border: "1px solid var(--bc-border)",
            borderRadius: "var(--bc-radius-sm)",
            boxShadow: "var(--bc-shadow-lg)",
            maxHeight: 280,
            overflowY: "auto",
          }}
        >
          {services.map((service, index) => (
            <li key={service.name} role="presentation">
              <button
                type="button"
                id={listboxId + "-" + index}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(service)}
                style={{
                  width: "100%",
                  display: "block",
                  padding: "10px 12px",
                  border: 0,
                  borderRadius: 6,
                  textAlign: "left",
                  color: "var(--bc-ink)",
                  background: index === activeIndex ? "var(--bc-gold-soft)" : "#fff",
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 15,
                  fontWeight: 600,
                }}
              >
                {service.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && !tooShort && state.kind === "results" && state.query === trimmed && services.length === 0 && (
        <p style={{ fontSize: 13, color: hintColor, marginTop: 6 }}>
          No exact service name matches. Find salons will still look for similar names.
        </p>
      )}
      {open && !tooShort && state.kind === "loading" && state.query === trimmed && (
        <p style={{ fontSize: 13, color: hintColor, marginTop: 6 }}>Searching services…</p>
      )}
      {open && !tooShort && state.kind === "failed" && state.query === trimmed && (
        <p role="alert" style={{ fontSize: 13, color: "var(--fq-orange, #ff7a3d)", marginTop: 6 }}>
          Could not load service suggestions. You can still try Find salons.
        </p>
      )}
    </div>
  );
}
