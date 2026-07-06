"use client";

// FR-6 (price scoping) + FR-10, BR-5 (3D viewer + fallback).
// Client component so DiamondViewer can use lazy imports and browser APIs.

import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

// Dynamically import the full viewer — Three.js never enters the SSR bundle.
// ssr:false ensures the canvas only mounts client-side, avoiding WebGL SSR issues.
const DiamondViewer = dynamic(
  () => import("@/components/viewer/DiamondViewer"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-[400px] rounded-xl bg-slate-50 animate-pulse" aria-label="Loading diamond viewer…" />
    ),
  }
);

interface CatalogStone {
  stone_id: string;
  internal_ref: string;
  shape: string | null;
  carat_weight: string | null;
  confirmed_color: string | null;
  confirmed_clarity: string | null;
  confirmed_cut: string | null;
  effective_price_usd: string | null;
  is_stale: boolean;
  is_hard_blocked: boolean;
  cert_number: string | null;
  lab: string | null;
  fluorescence: string | null;
  measurements_mm: string | null;
  polish: string | null;
  symmetry: string | null;
  entry_id: string;
}

interface PassportSummary {
  event_count: number;
  head_hash: string | null;
  valid: boolean;
  validation_detail: string;
}

interface Props {
  stone: CatalogStone;
  passportSummary: PassportSummary | null;
}

export default function CatalogStoneDetail({ stone, passportSummary }: Props) {
  const [inquiryBusy, setInquiryBusy] = useState(false);
  const [inquiryMsg, setInquiryMsg] = useState("");
  const [inquiryNote, setInquiryNote] = useState("");

  // Map stone to the shape DiamondViewer and SpecsFallback expect.
  const stoneForViewer = {
    id: stone.stone_id,
    internal_ref: stone.internal_ref,
    shape: stone.shape,
    carat_weight: stone.carat_weight,
    confirmed_color: stone.confirmed_color,
    confirmed_clarity: stone.confirmed_clarity,
    confirmed_cut: stone.confirmed_cut,
    lab: stone.lab,
    cert_number: stone.cert_number,
    fluorescence: stone.fluorescence,
    measurements_mm: stone.measurements_mm,
    polish: stone.polish,
    symmetry: stone.symmetry,
  };

  async function submitInquiry() {
    setInquiryBusy(true);
    setInquiryMsg("");
    const res = await fetch(`/api/catalog/${stone.stone_id}/inquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: inquiryNote || null }),
    });
    setInquiryBusy(false);
    if (res.ok) {
      setInquiryMsg("Inquiry submitted — we will be in touch shortly.");
      setInquiryNote("");
    } else {
      const err = await res.json();
      setInquiryMsg(err.error ?? "Failed to submit inquiry.");
    }
  }

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Link href="/catalog" className="text-sm text-blue-600 hover:underline">
        ← Back to catalog
      </Link>

      {/* Stone header */}
      <div>
        <p className="text-xs text-gray-400 uppercase tracking-wide">
          {stone.shape?.replace(/_/g, " ") ?? "Diamond"}
        </p>
        <h1 className="text-2xl font-bold text-gray-900 mt-0.5">
          {stone.carat_weight ? `${stone.carat_weight} ct` : stone.internal_ref}
        </h1>
        <p className="text-sm text-gray-500">{stone.internal_ref}</p>
      </div>

      {/* ── 3D viewer (ssr:false dynamic import) ───────────────────────────── */}
      {/* DiamondViewer handles WebGL detection and falls back to SpecsFallback  */}
      {/* automatically when WebGL is unavailable or the device is low-power.    */}
      <DiamondViewer stone={stoneForViewer} canvasHeight={400} />

      {/* ── Price card ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Your price</p>
            {stone.is_hard_blocked ? (
              <p className="text-gray-400 italic text-sm">
                Price is temporarily unavailable — contact us for current pricing.
              </p>
            ) : stone.effective_price_usd ? (
              <p className="text-3xl font-bold text-gray-900">
                ${Number(stone.effective_price_usd).toLocaleString()}
              </p>
            ) : (
              <p className="text-gray-400 text-sm">—</p>
            )}
            {stone.is_stale && !stone.is_hard_blocked && (
              <p className="text-xs text-amber-600 mt-1">
                Price may be outdated — confirm with your sales contact
              </p>
            )}
          </div>

          <div className="text-right">
            <p className="text-sm font-semibold text-gray-700">
              {stone.confirmed_color} · {stone.confirmed_clarity} · {stone.confirmed_cut ?? "—"}
            </p>
            {stone.carat_weight && (
              <p className="text-sm text-gray-500">{stone.carat_weight} ct</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Specs (always rendered for assistive tech and search engines) ────── */}
      {/* This is a plain spec table, separate from the 3D viewer fallback.       */}
      {/* The SpecsFallback above is only shown when WebGL is unavailable.         */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">
          Full Specifications
        </h2>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4 text-sm">
          <SpecRow label="Color" value={stone.confirmed_color} />
          <SpecRow label="Clarity" value={stone.confirmed_clarity} />
          <SpecRow label="Cut" value={stone.confirmed_cut} />
          <SpecRow label="Carat" value={stone.carat_weight ? `${stone.carat_weight} ct` : null} />
          <SpecRow label="Shape" value={stone.shape?.replace(/_/g, " ")} />
          <SpecRow label="Fluorescence" value={stone.fluorescence} />
          {stone.measurements_mm && (
            <SpecRow label="Measurements" value={stone.measurements_mm} />
          )}
          {stone.polish && <SpecRow label="Polish" value={stone.polish} />}
          {stone.symmetry && <SpecRow label="Symmetry" value={stone.symmetry} />}
        </dl>

        {(stone.lab || stone.cert_number) && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Certificate
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              {stone.lab && <SpecRow label="Lab" value={stone.lab} />}
              {stone.cert_number && <SpecRow label="Cert #" value={stone.cert_number} />}
            </dl>
          </div>
        )}

        <p className="mt-4 text-xs text-gray-400">
          LucidCarat grades are computer-vision decision aids — not official GIA/IGI certificates.
        </p>
      </div>

      {/* ── Diamond Passport summary ─────────────────────────────────────────── */}
      {passportSummary && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Diamond Passport
          </h2>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
                passportSummary.valid
                  ? "bg-green-50 text-green-700"
                  : "bg-red-50 text-red-600"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  passportSummary.valid ? "bg-green-500" : "bg-red-500"
                }`}
              />
              {passportSummary.valid ? "Chain verified" : "Chain integrity issue"}
            </span>
            <span className="text-xs text-gray-400">
              {passportSummary.event_count} provenance event
              {passportSummary.event_count !== 1 ? "s" : ""}
            </span>
          </div>
          {passportSummary.head_hash && (
            <p className="mt-2 text-xs text-gray-400 font-mono break-all">
              Head: {passportSummary.head_hash.slice(0, 32)}…
            </p>
          )}
          <p className="mt-1 text-xs text-gray-400">
            Chain integrity proves tamper-evidence of this record; it does not constitute proof
            of real-world origin.
          </p>
          <div className="mt-3 flex gap-3">
            <a
              href={`/api/stones/${stone.stone_id}/passport/export?format=json`}
              className="text-xs text-blue-600 hover:underline"
              download
            >
              Export JSON
            </a>
            <a
              href={`/api/stones/${stone.stone_id}/passport/export?format=pdf`}
              className="text-xs text-blue-600 hover:underline"
              download
            >
              Export PDF
            </a>
          </div>
        </div>
      )}

      {/* ── Inquiry form ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Submit Inquiry
        </h2>
        {inquiryMsg ? (
          <p
            className={`text-sm px-4 py-3 rounded-lg ${
              inquiryMsg.includes("submitted")
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-600"
            }`}
          >
            {inquiryMsg}
          </p>
        ) : (
          <div className="space-y-3">
            <textarea
              value={inquiryNote}
              onChange={(e) => setInquiryNote(e.target.value)}
              rows={3}
              placeholder="Any questions or specific requirements? (optional)"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={submitInquiry}
              disabled={inquiryBusy}
              className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {inquiryBusy ? "Submitting…" : "Submit Inquiry"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SpecRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs text-gray-400">{label}</dt>
      <dd className="mt-0.5 font-medium text-gray-800">{value ?? "—"}</dd>
    </div>
  );
}
