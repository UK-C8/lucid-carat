"use client";

import { useState, useEffect, useCallback } from "react";

/* ── Types ─────────────────────────────────────────────────────────── */

interface Driver {
  feature: string;
  direction: "up" | "down";
  value: unknown;
  importance: number;
}

interface Stone {
  id: string;
  internal_ref: string | null;
  status: string;
  shape: string | null;
  carat_weight: string | null;
  lab_grown: string;
  cert_id: string | null;
  lab: string | null;
  cert_number: string | null;
  cert_carat: string | null;
  cert_shape: string | null;
  color_grade: string | null;
  clarity_grade: string | null;
  cut_grade: string | null;
  polish: string | null;
  symmetry: string | null;
  fluorescence: string | null;
  measurements_mm: string | null;
  depth_pct: string | null;
  table_pct: string | null;
  cert_lab_grown: string | null;
  low_confidence_fields: string[] | null;
  confirmed_color: string | null;
  confirmed_clarity: string | null;
  confirmed_cut: string | null;
  confirmed_at: string | null;
  video_s3_key: string | null;
  grading: GradingResult | null;
  forecast: Forecast | null;
}

interface GradingResult {
  id: string;
  source: string;
  color_grade: string | null;
  clarity_grade: string | null;
  cut_grade: string | null;
  color_confidence: string | null;
  clarity_confidence: string | null;
  cut_confidence: string | null;
  color_disagrees_with_cert: boolean;
  clarity_disagrees_with_cert: boolean;
  cut_disagrees_with_cert: boolean;
}

interface ReviewState {
  stone_status: string;
  cv_color: string | null;
  cv_cut: string | null;
  cv_clarity: string | null;
  color_confidence: number | null;
  cut_confidence: number | null;
  clarity_confidence: number | null;
  color_disagrees_with_cert: boolean;
  cut_disagrees_with_cert: boolean;
  clarity_disagrees_with_cert: boolean;
  confirmed_color: string | null;
  confirmed_cut: string | null;
  confirmed_clarity: string | null;
  ready_to_advance: boolean;
  unactioned_dimensions: string[];
  cert_color: string | null;
  cert_cut: string | null;
  cert_clarity: string | null;
}

interface Forecast {
  id: string;
  model_version: string;
  fair_price_usd: string;
  confidence_low_usd: string;
  confidence_high_usd: string;
  confidence_level: string;
  top_drivers: Driver[];
  markup_pct: string | null;
}

/* ── Constants ─────────────────────────────────────────────────────── */

const COLORS = ["D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"];
const CLARITIES = ["FL","IF","VVS1","VVS2","VS1","VS2","SI1","SI2","I1","I2","I3"];
const CUTS = ["Excellent","Very Good","Good","Fair","Poor"];

const STATUS_COLORS: Record<string, string> = {
  uploaded: "bg-gray-100 text-gray-600",
  grading: "bg-yellow-100 text-yellow-700",
  priced: "bg-green-100 text-green-700",
  published: "bg-blue-100 text-blue-700",
  sold: "bg-purple-100 text-purple-700",
};

/* ── Helpers ───────────────────────────────────────────────────────── */


/* ── Sub-components ────────────────────────────────────────────────── */

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-gray-300 text-xs">—</span>;
  const pctVal = Math.round(value * 100);
  const color = pctVal >= 70 ? "bg-green-500" : pctVal >= 45 ? "bg-yellow-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pctVal}%` }} />
      </div>
      <span className="text-xs text-gray-500">{pctVal}%</span>
    </div>
  );
}

function DisagreeBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-medium">
      ⚠ disagrees with cert
    </span>
  );
}

function LowConfBadge({ field }: { field: string }) {
  return (
    <span className="inline-flex text-xs bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded font-medium">
      {field}: low confidence
    </span>
  );
}

/* ── Main component ─────────────────────────────────────────────────── */

export default function StoneDetail({ initialStone }: { initialStone: Stone }) {
  const [stone, setStone] = useState<Stone>(initialStone);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string>("idle");
  const [gradingBusy, setGradingBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [forecastBusy, setForecastBusy] = useState(false);
  const [markupBusy, setMarkupBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [overrideModal, setOverrideModal] = useState<{
    dim: string;
    currentGrade: string;
    grades: string[];
  } | null>(null);
  const [overrideGrade, setOverrideGrade] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [markupPct, setMarkupPct] = useState("0");
  const [markupNote, setMarkupNote] = useState("");
  const [listPrice, setListPrice] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const stoneId = stone.id;

  const refreshStone = useCallback(async () => {
    const resp = await fetch(`/api/stones/${stoneId}`);
    if (resp.ok) {
      const data = await resp.json();
      setStone(data);
    }
  }, [stoneId]);

  const refreshReview = useCallback(async () => {
    const resp = await fetch(`/api/stones/${stoneId}/grade/review`);
    if (resp.ok) setReview(await resp.json());
  }, [stoneId]);

  // Load review state if stone is in grading status
  useEffect(() => {
    if (stone.status === "grading") refreshReview();
  }, [stone.status, refreshReview]);

  // Poll job status
  useEffect(() => {
    if (!jobId || jobStatus === "completed" || jobStatus === "failed") return;
    const interval = setInterval(async () => {
      const resp = await fetch(`/api/stones/${stoneId}/grade/status?job_id=${jobId}`);
      if (!resp.ok) return;
      const data = await resp.json();
      setJobStatus(data.status);
      if (data.status === "completed" || data.status === "failed") {
        clearInterval(interval);
        await refreshStone();
        await refreshReview();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [jobId, jobStatus, stoneId, refreshStone, refreshReview]);

  async function startGrading() {
    setGradingBusy(true);
    setError("");
    const videoPath = stone.video_s3_key?.startsWith("local/")
      ? `/tmp/lucidcarat-uploads/${stone.video_s3_key.slice(6)}`
      : null;

    const resp = await fetch(`/api/stones/${stoneId}/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_path: videoPath }),
    });
    setGradingBusy(false);

    if (resp.ok) {
      const data = await resp.json();
      setJobId(data.job_id);
      setJobStatus("submitted");
      await refreshStone();
    } else {
      const err = await resp.json();
      setError(err.detail ?? "Failed to start grading");
    }
  }

  async function confirmDimension(dim: string, grade: string) {
    setActionBusy(dim);
    setError("");
    const resp = await fetch(`/api/stones/${stoneId}/grade/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dimension: dim, action: "confirm", new_grade: grade }),
    });
    setActionBusy(null);
    if (resp.ok) {
      await refreshReview();
      await refreshStone();
    } else {
      const err = await resp.json();
      setError(err.detail ?? "Action failed");
    }
  }

  async function submitOverride() {
    if (!overrideModal) return;
    setActionBusy(overrideModal.dim);
    setError("");
    const resp = await fetch(`/api/stones/${stoneId}/grade/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dimension: overrideModal.dim,
        action: "override",
        new_grade: overrideGrade,
        override_reason: overrideReason,
      }),
    });
    setActionBusy(null);
    if (resp.ok) {
      setOverrideModal(null);
      setOverrideGrade("");
      setOverrideReason("");
      await refreshReview();
      await refreshStone();
    } else {
      const err = await resp.json();
      setError(err.detail ?? "Override failed");
    }
  }

  async function advanceToPrice() {
    setGradingBusy(true);
    setError("");
    const resp = await fetch(`/api/stones/${stoneId}/grade/advance`, { method: "POST" });
    setGradingBusy(false);
    if (resp.ok) {
      await refreshStone();
      setMsg("Stone advanced to priced stage — ready for price forecast");
    } else {
      const err = await resp.json();
      setError(
        typeof err.detail === "object"
          ? `Missing: ${err.detail.missing_dimensions?.join(", ")}`
          : err.detail ?? "Advance failed"
      );
    }
  }

  async function generateForecast() {
    setForecastBusy(true);
    setError("");
    const resp = await fetch(`/api/stones/${stoneId}/forecast`, { method: "POST" });
    setForecastBusy(false);
    if (resp.ok) {
      await refreshStone();
      setMsg("Price forecast generated");
    } else {
      const err = await resp.json();
      setError(err.error ?? err.detail ?? "Forecast failed");
    }
  }

  async function applyMarkup() {
    setMarkupBusy(true);
    setError("");
    const resp = await fetch(`/api/stones/${stoneId}/forecast/adjust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markup_pct: parseFloat(markupPct),
        adjustment_note: markupNote || null,
      }),
    });
    setMarkupBusy(false);
    if (resp.ok) {
      await refreshStone();
      setMsg("Markup applied");
    } else {
      const err = await resp.json();
      setError(err.detail ?? "Markup failed");
    }
  }

  async function publishStone() {
    setPublishBusy(true);
    setError("");
    const resp = await fetch(`/api/stones/${stoneId}/publish`, { method: "POST" });
    setPublishBusy(false);
    if (resp.ok) {
      await refreshStone();
      setMsg("Stone published to catalog");
    } else {
      const err = await resp.json();
      setError(err.error ?? "Publish failed");
    }
  }

  async function markPriced() {
    setMarkupBusy(true);
    setError("");
    const resp = await fetch(`/api/stones/${stoneId}/mark-priced`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list_price_usd: listPrice ? parseFloat(listPrice) : null }),
    });
    setMarkupBusy(false);
    if (resp.ok) {
      await refreshStone();
      setMsg("Stone marked as priced — metering event logged");
    } else {
      const err = await resp.json();
      setError(err.error ?? "Failed");
    }
  }

  const forecast = stone.forecast;
  const adjustedPrice = forecast
    ? parseFloat(forecast.fair_price_usd) * (1 + parseFloat(forecast.markup_pct ?? "0") / 100)
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            {stone.internal_ref ?? stone.id.slice(0, 8)}
          </h1>
          <p className="text-sm text-gray-500 font-mono mt-0.5">{stone.id}</p>
        </div>
        <span
          className={`inline-flex px-3 py-1 rounded-full text-sm font-medium ${
            STATUS_COLORS[stone.status] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {stone.status}
        </span>
      </div>

      {/* Messages */}
      {msg && (
        <div className="bg-green-50 text-green-700 text-sm px-4 py-3 rounded-lg border border-green-200">
          {msg}
        </div>
      )}
      {error && (
        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-lg border border-red-200">
          {error}
        </div>
      )}

      {/* ── Section 1: Certificate ────────────────────────────────── */}
      <Section title="Certificate" step={1}>
        {!stone.cert_id ? (
          <p className="text-sm text-gray-400">No certificate ingested.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-x-6 gap-y-2 text-sm">
              <KV label="Lab" value={stone.lab} />
              <KV label="Cert #" value={stone.cert_number} />
              <KV label="Carat Weight" value={stone.cert_carat ? `${stone.cert_carat} ct` : null} />
              <KV label="Shape" value={stone.cert_shape} />
              <KV label="Color" value={stone.color_grade} />
              <KV label="Clarity" value={stone.clarity_grade} />
              <KV label="Cut" value={stone.cut_grade} />
              <KV label="Fluorescence" value={stone.fluorescence} />
              <KV label="Measurements" value={stone.measurements_mm} />
              <KV label="Depth %" value={stone.depth_pct} />
              <KV label="Table %" value={stone.table_pct} />
              <KV label="Lab Grown" value={stone.cert_lab_grown} />
            </div>
            {stone.low_confidence_fields && stone.low_confidence_fields.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {stone.low_confidence_fields.map((f) => (
                  <LowConfBadge key={f} field={f} />
                ))}
              </div>
            )}
          </>
        )}
      </Section>

      {/* ── Section 2: CV Grading ─────────────────────────────────── */}
      <Section title="CV Grading" step={2}>
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <span className="mt-0.5 text-amber-500 text-base leading-none">⚠</span>
          <p className="text-sm font-medium text-amber-800">
            Provisional results — grading and pricing models are in training. Values shown are
            placeholders, not validated assessments.
          </p>
        </div>
        {stone.status === "uploaded" && !jobId && (
          <div className="flex items-center gap-4">
            <button
              onClick={startGrading}
              disabled={gradingBusy}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {gradingBusy ? "Submitting…" : "Start CV Grading"}
            </button>
            {!stone.video_s3_key?.startsWith("local/") && (
              <p className="text-xs text-amber-600">No video attached — grading will produce low-confidence results.</p>
            )}
          </div>
        )}

        {jobId && jobStatus !== "completed" && jobStatus !== "failed" && (
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-600">
              Grading in progress ({jobStatus})… polling every 3s
            </span>
          </div>
        )}

        {jobStatus === "failed" && (
          <p className="text-sm text-red-600">Grading job failed. Check logs.</p>
        )}

        {review && (
          <div className="space-y-4">
            <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
              ⚠ LucidCarat grades are decision aids — not official GIA/IGI certificates.
            </p>

            {(["color", "cut", "clarity"] as const).map((dim) => {
              const cvGrade = review[`cv_${dim}` as keyof ReviewState] as string | null;
              const conf = review[`${dim}_confidence` as keyof ReviewState] as number | null;
              const disagrees = review[`${dim}_disagrees_with_cert` as keyof ReviewState] as boolean;
              const confirmed = review[`confirmed_${dim}` as keyof ReviewState] as string | null;
              const certGrade = review[`cert_${dim}` as keyof ReviewState] as string | null;
              const grades = dim === "color" ? COLORS : dim === "clarity" ? CLARITIES : CUTS;
              const isNA = dim === "cut" && !cvGrade && stone.shape !== "round_brilliant";

              return (
                <div key={dim} className="border border-gray-100 rounded-lg p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                        {dim}
                      </p>
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-semibold text-gray-900">
                          {cvGrade ?? (isNA ? "N/A" : "—")}
                        </span>
                        {disagrees && <DisagreeBadge />}
                      </div>
                      <ConfidenceBar value={conf} />
                      {certGrade && (
                        <p className="text-xs text-gray-400 mt-1">Cert: {certGrade}</p>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      {confirmed ? (
                        <span className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded font-medium">
                          ✓ confirmed: {confirmed}
                        </span>
                      ) : isNA ? (
                        <span className="text-xs text-gray-400">Not applicable</span>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            disabled={!!actionBusy || !cvGrade}
                            onClick={() => confirmDimension(dim, cvGrade!)}
                            className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                          >
                            {actionBusy === dim ? "…" : "Confirm"}
                          </button>
                          <button
                            disabled={!!actionBusy || !cvGrade}
                            onClick={() => {
                              setOverrideModal({ dim, currentGrade: cvGrade ?? "", grades });
                              setOverrideGrade(cvGrade ?? grades[0]);
                              setOverrideReason("");
                            }}
                            className="px-3 py-1 text-xs border border-gray-200 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50"
                          >
                            Override
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {review.ready_to_advance && (
              <button
                onClick={advanceToPrice}
                disabled={gradingBusy}
                className="w-full py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {gradingBusy ? "Advancing…" : "All grades confirmed — Advance to Pricing →"}
              </button>
            )}

            {!review.ready_to_advance && review.unactioned_dimensions.length > 0 && (
              <p className="text-xs text-amber-600 text-center">
                Still need: {review.unactioned_dimensions.join(", ")}
              </p>
            )}
          </div>
        )}

        {stone.status !== "uploaded" && stone.status !== "grading" && !review && (
          <div className="text-sm text-gray-500">
            Grading complete.{" "}
            <span className="text-gray-400">
              {stone.confirmed_color} / {stone.confirmed_clarity} / {stone.confirmed_cut ?? "N/A"}
            </span>
          </div>
        )}
      </Section>

      {/* ── Section 3: Price Forecast ─────────────────────────────── */}
      <Section title="Price Forecast" step={3}>
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <span className="mt-0.5 text-amber-500 text-base leading-none">⚠</span>
          <p className="text-sm font-medium text-amber-800">
            Provisional results — grading and pricing models are in training. Values shown are
            placeholders, not validated assessments.
          </p>
        </div>
        {stone.status === "grading" || stone.status === "uploaded" ? (
          <p className="text-sm text-gray-400">Complete grading before generating a forecast.</p>
        ) : !forecast ? (
          <button
            onClick={generateForecast}
            disabled={forecastBusy}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {forecastBusy ? "Generating…" : "Generate Price Forecast"}
          </button>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gray-50 rounded-lg p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">Low (90% CI)</p>
                <p className="text-lg font-semibold text-gray-700">
                  ${Number(forecast.confidence_low_usd).toLocaleString()}
                </p>
              </div>
              <div className="bg-blue-50 rounded-lg p-4 text-center border border-blue-100">
                <p className="text-xs text-blue-600 mb-1">Fair Price</p>
                <p className="text-2xl font-bold text-blue-700">
                  ${Number(forecast.fair_price_usd).toLocaleString()}
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">High (90% CI)</p>
                <p className="text-lg font-semibold text-gray-700">
                  ${Number(forecast.confidence_high_usd).toLocaleString()}
                </p>
              </div>
            </div>

            <div className="text-xs text-gray-400">
              Model: {forecast.model_version} · 90% confidence interval
            </div>

            {/* Top drivers */}
            {forecast.top_drivers?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-600 mb-2 uppercase tracking-wide">Top Price Drivers</p>
                <div className="space-y-2">
                  {forecast.top_drivers.slice(0, 5).map((d, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      <span
                        className={`text-base ${
                          d.direction === "up" ? "text-green-500" : "text-red-400"
                        }`}
                      >
                        {d.direction === "up" ? "↑" : "↓"}
                      </span>
                      <span className="text-gray-700 flex-1">{d.feature.replace(/_/g, " ")}</span>
                      <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            d.direction === "up" ? "bg-green-400" : "bg-red-300"
                          }`}
                          style={{ width: `${Math.round(d.importance * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 w-10 text-right">
                        {Math.round(d.importance * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Markup */}
            <div className="border-t border-gray-100 pt-4">
              <p className="text-sm font-medium text-gray-700 mb-3">Apply Markup / Markdown</p>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  value={markupPct}
                  onChange={(e) => setMarkupPct(e.target.value)}
                  step="0.5"
                  placeholder="0"
                  className="w-24 px-3 py-2 border border-gray-200 rounded-lg text-sm text-center"
                />
                <span className="text-sm text-gray-500">%</span>
                <input
                  type="text"
                  value={markupNote}
                  onChange={(e) => setMarkupNote(e.target.value)}
                  placeholder="Note (optional)"
                  className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
                <button
                  onClick={applyMarkup}
                  disabled={markupBusy}
                  className="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-900 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>

              {forecast.markup_pct && parseFloat(forecast.markup_pct) !== 0 && (
                <div className="mt-3 bg-gray-50 rounded-lg p-3 flex items-center justify-between">
                  <span className="text-sm text-gray-600">
                    Adjusted price ({forecast.markup_pct}% markup):
                  </span>
                  <span className="text-lg font-bold text-gray-900">
                    ${adjustedPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ── Section 4: Mark as Priced ─────────────────────────────── */}
      {(stone.status === "priced") && (
        <Section title="Mark as Priced" step={4}>
          <p className="text-sm text-gray-600 mb-4">
            Set the final list price and confirm this stone is ready. This logs a Stripe metering
            event against your per-stone usage.
          </p>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">$</span>
            <input
              type="number"
              value={listPrice}
              onChange={(e) => setListPrice(e.target.value)}
              placeholder={
                adjustedPrice
                  ? adjustedPrice.toFixed(2)
                  : forecast
                  ? forecast.fair_price_usd
                  : "e.g. 4500"
              }
              className="w-40 px-3 py-2 border border-gray-200 rounded-lg text-sm"
              step="0.01"
              min="0"
            />
            <button
              onClick={markPriced}
              disabled={markupBusy}
              className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {markupBusy ? "Saving…" : "Confirm List Price"}
            </button>
          </div>
        </Section>
      )}

      {/* ── Section 5: Publish to Catalog ────────────────────────── */}
      {stone.status === "priced" && (
        <Section title="Publish to Catalog" step={5}>
          <p className="text-sm text-gray-600 mb-4">
            Once you have confirmed the list price above, publish this stone to make it visible
            to buyers in the private catalog with their assigned pricing.
          </p>
          <button
            onClick={publishStone}
            disabled={publishBusy}
            className="px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {publishBusy ? "Publishing…" : "Publish to Catalog →"}
          </button>
        </Section>
      )}

      {stone.status === "published" && (
        <Section title="Published" step={5}>
          <div className="flex items-center gap-2 text-green-700 text-sm font-medium">
            <span>✓</span>
            <span>This stone is live in the catalog. Buyers with access can view and inquire.</span>
          </div>
        </Section>
      )}

      {/* Override Modal */}
      {overrideModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="font-semibold text-gray-900">
              Override {overrideModal.dim} grade
            </h3>
            <div>
              <label className="block text-xs text-gray-600 mb-1">New grade *</label>
              <select
                value={overrideGrade}
                onChange={(e) => setOverrideGrade(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              >
                {overrideModal.grades.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Reason for override *</label>
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                rows={3}
                placeholder="e.g. Physical inspection under loupe shows E color, not D"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={submitOverride}
                disabled={!overrideReason.trim() || !!actionBusy}
                className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {actionBusy ? "Saving…" : "Save override"}
              </button>
              <button
                onClick={() => setOverrideModal(null)}
                className="flex-1 py-2 border border-gray-200 text-gray-700 text-sm rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Layout helpers ─────────────────────────────────────────────────── */

function Section({
  title,
  step,
  children,
}: {
  title: string;
  step: number;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center gap-3 mb-4">
        <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">
          {step}
        </span>
        <h2 className="font-semibold text-gray-900">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-sm font-medium text-gray-800">{value ?? "—"}</p>
    </div>
  );
}
