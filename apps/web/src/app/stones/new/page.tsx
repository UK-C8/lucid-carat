"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CERT_DEFAULTS = {
  lab: "GIA",
  cert_number: "",
  carat_weight: "",
  shape: "round_brilliant",
  color_grade: "",
  clarity_grade: "",
  cut_grade: "",
  polish: "",
  symmetry: "",
  fluorescence: "None",
  measurements_mm: "",
  depth_pct: "",
  table_pct: "",
  issued_date: "",
};

export default function NewStonePage() {
  const router = useRouter();
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [certFields, setCertFields] = useState(CERT_DEFAULTS);
  const [internalRef, setInternalRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  function setCert(k: string, v: string) {
    setCertFields((prev) => ({ ...prev, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    const fd = new FormData();
    if (videoFile) fd.append("video", videoFile);
    if (internalRef) fd.append("internal_ref", internalRef);

    const certData = {
      lab: certFields.lab,
      fields: {
        cert_number: certFields.cert_number || null,
        carat_weight: certFields.carat_weight || null,
        shape: certFields.shape || null,
        color_grade: certFields.color_grade || null,
        clarity_grade: certFields.clarity_grade || null,
        cut_grade: certFields.cut_grade || null,
        polish: certFields.polish || null,
        symmetry: certFields.symmetry || null,
        fluorescence: certFields.fluorescence || null,
        measurements_mm: certFields.measurements_mm || null,
        depth_pct: certFields.depth_pct || null,
        table_pct: certFields.table_pct || null,
        issued_date: certFields.issued_date || null,
        full_text: `${certFields.lab} ${certFields.cert_number} ${certFields.carat_weight}ct`,
      },
    };
    fd.append("cert_data", JSON.stringify(certData));

    const resp = await fetch("/api/stones", {
      method: "POST",
      body: fd,
    });

    setSubmitting(false);

    if (!resp.ok) {
      const err = await resp.json();
      setError(err.error ?? "Upload failed");
      return;
    }

    const data = await resp.json();

    if (data.warning) {
      setWarning(data.warning);
      // Still navigate to the stone — it was saved, just cert processing is pending
      setTimeout(() => router.push(`/stones/${data.stone_id}`), 2500);
      return;
    }

    router.push(`/stones/${data.stone_id}`);
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => router.back()}
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          ← Back
        </button>
        <h1 className="text-xl font-semibold text-gray-900">Upload New Stone</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Stone metadata */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-medium text-gray-900 mb-4">Stone Details</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Internal Reference</label>
              <input
                type="text"
                value={internalRef}
                onChange={(e) => setInternalRef(e.target.value)}
                placeholder="e.g. SD-2024-001"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                360° Video (optional for Phase 1)
              </label>
              <input
                type="file"
                accept="video/*"
                onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
              />
              {!videoFile && (
                <p className="text-xs text-amber-600 mt-1">
                  No video — grading will run on a synthetic test video. Attach a real 360° video for meaningful CV results.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Certificate data */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-medium text-gray-900 mb-1">Certificate Data</h2>
          <p className="text-xs text-amber-600 mb-4">
            ⚠ Carat weight comes from the cert only — never from CV (FR-2).
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Lab" required>
              <select
                value={certFields.lab}
                onChange={(e) => setCert("lab", e.target.value)}
                className={fieldClass}
              >
                <option value="GIA">GIA</option>
                <option value="IGI">IGI</option>
                <option value="HRD">HRD</option>
                <option value="AGS">AGS</option>
              </select>
            </Field>

            <Field label="Cert Number" required>
              <input
                type="text"
                value={certFields.cert_number}
                onChange={(e) => setCert("cert_number", e.target.value)}
                placeholder="2141438167"
                className={fieldClass}
                required
              />
            </Field>

            <Field label="Carat Weight" required>
              <input
                type="number"
                step="0.001"
                min="0.01"
                value={certFields.carat_weight}
                onChange={(e) => setCert("carat_weight", e.target.value)}
                placeholder="1.01"
                className={fieldClass}
                required
              />
            </Field>

            <Field label="Shape">
              <select
                value={certFields.shape}
                onChange={(e) => setCert("shape", e.target.value)}
                className={fieldClass}
              >
                {SHAPES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </Field>

            <Field label="Color Grade" required>
              <select
                value={certFields.color_grade}
                onChange={(e) => setCert("color_grade", e.target.value)}
                className={fieldClass}
                required
              >
                <option value="">—</option>
                {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            <Field label="Clarity Grade" required>
              <select
                value={certFields.clarity_grade}
                onChange={(e) => setCert("clarity_grade", e.target.value)}
                className={fieldClass}
                required
              >
                <option value="">—</option>
                {CLARITIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            <Field label="Cut Grade">
              <select
                value={certFields.cut_grade}
                onChange={(e) => setCert("cut_grade", e.target.value)}
                className={fieldClass}
              >
                <option value="">N/A (fancy shape)</option>
                {CUTS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            <Field label="Fluorescence">
              <select
                value={certFields.fluorescence}
                onChange={(e) => setCert("fluorescence", e.target.value)}
                className={fieldClass}
              >
                {["None", "Faint", "Medium", "Strong", "Very Strong"].map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </Field>

            <Field label="Polish">
              <select
                value={certFields.polish}
                onChange={(e) => setCert("polish", e.target.value)}
                className={fieldClass}
              >
                <option value="">—</option>
                {CUTS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            <Field label="Symmetry">
              <select
                value={certFields.symmetry}
                onChange={(e) => setCert("symmetry", e.target.value)}
                className={fieldClass}
              >
                <option value="">—</option>
                {CUTS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            <Field label="Measurements (mm)">
              <input
                type="text"
                value={certFields.measurements_mm}
                onChange={(e) => setCert("measurements_mm", e.target.value)}
                placeholder="6.41 x 6.45 x 3.97"
                className={fieldClass}
              />
            </Field>

            <Field label="Depth %">
              <input
                type="number"
                step="0.1"
                value={certFields.depth_pct}
                onChange={(e) => setCert("depth_pct", e.target.value)}
                placeholder="61.4"
                className={fieldClass}
              />
            </Field>

            <Field label="Table %">
              <input
                type="number"
                step="0.1"
                value={certFields.table_pct}
                onChange={(e) => setCert("table_pct", e.target.value)}
                placeholder="57.0"
                className={fieldClass}
              />
            </Field>

            <Field label="Issued Date">
              <input
                type="date"
                value={certFields.issued_date}
                onChange={(e) => setCert("issued_date", e.target.value)}
                className={fieldClass}
              />
            </Field>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-lg">{error}</p>
        )}
        {warning && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 px-4 py-3 rounded-lg">
            ⚠ {warning}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? "Uploading…" : "Upload & Start Grading"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="px-6 py-2 text-gray-600 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

const fieldClass =
  "w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

const COLORS = ["D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"];
const CLARITIES = ["FL","IF","VVS1","VVS2","VS1","VS2","SI1","SI2","I1","I2","I3"];
const CUTS = ["Excellent","Very Good","Good","Fair","Poor"];
const SHAPES = [
  { value: "round_brilliant", label: "Round Brilliant" },
  { value: "princess", label: "Princess" },
  { value: "cushion", label: "Cushion" },
  { value: "oval", label: "Oval" },
  { value: "emerald", label: "Emerald" },
  { value: "pear", label: "Pear" },
  { value: "radiant", label: "Radiant" },
  { value: "asscher", label: "Asscher" },
  { value: "heart", label: "Heart" },
  { value: "marquise", label: "Marquise" },
  { value: "other", label: "Other" },
];
