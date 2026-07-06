"use client";

// FR-10, BR-5: Diamond 3D viewer with WebGL detection and specs fallback.
//
// Responsibilities:
//   - Detect WebGL2 support at runtime (avoids SSR crash, handles legacy browsers)
//   - Lazy-load the heavy R3F scene (Three.js never enters the SSR bundle)
//   - Render the WCAG 2.1 AA specs fallback when WebGL is unavailable or
//     on devices that report navigator.hardwareConcurrency <= 2 (low-power heuristic)
//   - Emit viewer_3d_opened analytics event (CLAUDE.md §11) exactly once per mount
//   - Allow the user to toggle between viewer and specs at any time
//
// Load-time target: < 3 seconds interactive on broadband (CLAUDE.md §7).
// Three.js + Drei ≈ 600 KB gzipped — lazy import keeps FCP unaffected.

import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import SpecsFallback from "./SpecsFallback";

const DiamondScene = lazy(() => import("./DiamondScene"));

// ── WebGL detection ───────────────────────────────────────────────────────────

function detectWebGL(): "supported" | "no-webgl" | "low-power" {
  // Low-power device heuristic: <= 2 logical CPUs.
  if (typeof navigator !== "undefined" && navigator.hardwareConcurrency <= 2) {
    return "low-power";
  }
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!ctx) return "no-webgl";
    return "supported";
  } catch {
    return "no-webgl";
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface StoneForViewer {
  id: string;
  internal_ref: string;
  shape: string | null;
  carat_weight: string | null;
  confirmed_color: string | null;
  confirmed_clarity: string | null;
  confirmed_cut: string | null;
  lab: string | null;
  cert_number: string | null;
  fluorescence: string | null;
  measurements_mm: string | null;
  polish: string | null;
  symmetry: string | null;
}

interface DiamondViewerProps {
  stone: StoneForViewer;
  /** Height of the 3D canvas. Defaults to 400px. */
  canvasHeight?: number;
}

type FallbackReason = "no-webgl" | "low-power" | "user-dismissed" | "error";

// ── Viewer component ──────────────────────────────────────────────────────────

export default function DiamondViewer({ stone, canvasHeight = 400 }: DiamondViewerProps) {
  // "pending" until WebGL check completes client-side (avoids hydration mismatch)
  const [webglState, setWebglState] = useState<
    "pending" | "supported" | "no-webgl" | "low-power"
  >("pending");
  const [fallbackReason, setFallbackReason] = useState<FallbackReason | null>(null);
  const [analyticsFired, setAnalyticsFired] = useState(false);
  const [sceneError, setSceneError] = useState(false);

  // Run WebGL detection only client-side.
  useEffect(() => {
    setWebglState(detectWebGL());
  }, []);

  // Emit viewer_3d_opened once WebGL is confirmed supported and canvas mounts.
  const emitAnalytics = useCallback(() => {
    if (analyticsFired) return;
    setAnalyticsFired(true);
    fetch(`/api/catalog/${stone.id}/viewer-opened`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stone_id: stone.id }),
    }).catch(() => {/* fire-and-forget; never block the UI */});
  }, [stone.id, analyticsFired]);

  // Trigger analytics as soon as 3D canvas is ready (not on fallback).
  useEffect(() => {
    if (webglState === "supported" && !fallbackReason) {
      // Small delay lets the canvas first frame render, matching "viewer opened" intent.
      const t = setTimeout(emitAnalytics, 600);
      return () => clearTimeout(t);
    }
  }, [webglState, fallbackReason, emitAnalytics]);

  const showFallback = fallbackReason !== null || webglState === "no-webgl" || webglState === "low-power" || sceneError;
  const activeFallbackReason: FallbackReason =
    fallbackReason ??
    (sceneError ? "error" :
     webglState === "no-webgl" ? "no-webgl" :
     webglState === "low-power" ? "low-power" : "user-dismissed");

  // ── Render ─────────────────────────────────────────────────────────────────

  if (webglState === "pending") {
    // Skeleton prevents layout shift while detection runs (<10ms).
    return (
      <div
        style={{ height: canvasHeight }}
        className="w-full rounded-xl bg-slate-50 animate-pulse"
        aria-busy="true"
        aria-label="Loading diamond viewer…"
      />
    );
  }

  if (showFallback) {
    return (
      <div className="space-y-3">
        <SpecsFallback stone={stone} reason={activeFallbackReason} />
        {/* Allow recovering to 3D if user dismissed or errored */}
        {(fallbackReason === "user-dismissed" || fallbackReason === "error") &&
          webglState === "supported" && (
            <button
              onClick={() => { setFallbackReason(null); setSceneError(false); }}
              className="text-xs text-blue-600 hover:underline"
            >
              Show 3D viewer
            </button>
          )}
      </div>
    );
  }

  // 3D path
  return (
    <div className="space-y-3">
      <div
        className="w-full rounded-xl overflow-hidden bg-gradient-to-b from-slate-900 to-slate-800 relative"
        style={{ height: canvasHeight }}
        role="img"
        aria-label={`Interactive 3D model of ${stone.internal_ref}, ${stone.confirmed_color ?? ""} color ${stone.confirmed_clarity ?? ""} clarity ${stone.carat_weight ?? ""} carat diamond`}
      >
        <Suspense fallback={<ViewerSkeleton height={canvasHeight} />}>
          {!sceneError && (
            <ErrorBoundary onError={() => setSceneError(true)}>
              <DiamondScene
                color={stone.confirmed_color ?? "G"}
                onContextLost={() => setSceneError(true)}
              />
            </ErrorBoundary>
          )}
          {sceneError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-slate-400">3D render failed</p>
            </div>
          )}
        </Suspense>

        {/* Controls hint — hidden from screen readers (decorative) */}
        <p
          aria-hidden="true"
          className="absolute bottom-3 left-0 right-0 text-center text-xs text-slate-400 pointer-events-none"
        >
          Drag to rotate · Scroll to zoom
        </p>
      </div>

      {/* Accessible toggle to specs */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">
          {stone.confirmed_color} · {stone.confirmed_clarity} · {stone.confirmed_cut ?? "—"} ·{" "}
          {stone.carat_weight ? `${stone.carat_weight} ct` : "—"}
        </span>
        <button
          onClick={() => setFallbackReason("user-dismissed")}
          className="text-xs text-gray-400 hover:text-gray-600 hover:underline"
        >
          Switch to specs view
        </button>
      </div>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function ViewerSkeleton({ height }: { height: number }) {
  return (
    <div
      className="w-full h-full flex items-center justify-center"
      style={{ height }}
      aria-hidden="true"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-slate-500 border-t-white rounded-full animate-spin" />
        <p className="text-xs text-slate-400">Loading 3D viewer…</p>
      </div>
    </div>
  );
}

// ── Error boundary (class component, required by React) ───────────────────────

import { Component, ReactNode } from "react";

class ErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; onError: () => void }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error) {
    console.error("[DiamondViewer] R3F scene error:", error?.message ?? error, error?.stack?.slice(0, 500));
    this.props.onError();
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
