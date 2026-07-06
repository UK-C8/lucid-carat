"use client";

// Non-3D specs fallback — shown when WebGL is unavailable, device is low-power,
// or the user explicitly dismisses the viewer.
// WCAG 2.1 AA requirement per CLAUDE.md §7 — not optional polish.

interface SpecsFallbackProps {
  stone: {
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
  };
  reason?: "no-webgl" | "low-power" | "user-dismissed" | "error";
}

const REASON_LABEL: Record<string, string> = {
  "no-webgl":       "3D viewer requires WebGL (not available in this browser)",
  "low-power":      "3D viewer disabled on low-power devices",
  "user-dismissed": "3D viewer hidden",
  "error":          "3D viewer failed to load",
};

export default function SpecsFallback({ stone, reason }: SpecsFallbackProps) {
  return (
    <div
      role="region"
      aria-label="Diamond specifications"
      className="w-full rounded-xl border border-gray-200 bg-white overflow-hidden"
    >
      {/* Diamond silhouette + identity header */}
      <div className="bg-gradient-to-br from-slate-50 to-blue-50 px-6 py-8 flex items-center gap-6">
        {/* SVG silhouette of a round brilliant — decorative, aria-hidden */}
        <svg
          aria-hidden="true"
          width="80"
          height="90"
          viewBox="0 0 80 90"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="shrink-0"
        >
          {/* Simplified brilliant cut outline */}
          <polygon
            points="40,2 72,22 72,22 40,38 8,22"
            fill="#e0eeff"
            stroke="#93b4d8"
            strokeWidth="1.5"
          />
          <polygon
            points="8,22 40,38 40,88 8,22"
            fill="#c8ddf5"
            stroke="#93b4d8"
            strokeWidth="1.5"
          />
          <polygon
            points="72,22 40,38 40,88 72,22"
            fill="#d6e8f8"
            stroke="#93b4d8"
            strokeWidth="1.5"
          />
          {/* Table */}
          <line x1="22" y1="22" x2="58" y2="22" stroke="#7aa8d0" strokeWidth="1" />
        </svg>

        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-0.5">
            {stone.shape?.replace(/_/g, " ") ?? "Diamond"}
          </p>
          <h2 className="text-xl font-bold text-gray-900 leading-tight">
            {stone.carat_weight ? `${stone.carat_weight} ct` : stone.internal_ref}
          </h2>
          {stone.carat_weight && (
            <p className="text-sm text-gray-500">{stone.internal_ref}</p>
          )}
        </div>
      </div>

      {reason && reason !== "user-dismissed" && (
        <div className="px-6 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-700">
          {REASON_LABEL[reason]}
        </div>
      )}

      {/* Specs grid */}
      <div className="px-6 py-5">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
          4Cs &amp; Certificate
        </p>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          <SpecItem label="Color" value={stone.confirmed_color} highlight />
          <SpecItem label="Clarity" value={stone.confirmed_clarity} highlight />
          <SpecItem label="Cut" value={stone.confirmed_cut} highlight />
          <SpecItem label="Carat" value={stone.carat_weight ? `${stone.carat_weight} ct` : null} />
          <SpecItem label="Shape" value={stone.shape?.replace(/_/g, " ")} />
          <SpecItem label="Fluorescence" value={stone.fluorescence} />
          {stone.measurements_mm && (
            <SpecItem label="Measurements" value={stone.measurements_mm} span />
          )}
          {stone.polish && <SpecItem label="Polish" value={stone.polish} />}
          {stone.symmetry && <SpecItem label="Symmetry" value={stone.symmetry} />}
        </dl>

        {(stone.lab || stone.cert_number) && (
          <div className="mt-5 pt-4 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Certificate
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
              {stone.lab && <SpecItem label="Lab" value={stone.lab} />}
              {stone.cert_number && <SpecItem label="Cert #" value={stone.cert_number} />}
            </dl>
          </div>
        )}

        <p className="mt-5 text-xs text-gray-400 leading-relaxed">
          LucidCarat grades are computer-vision decision aids — not official GIA/IGI certificates.
        </p>
      </div>
    </div>
  );
}

function SpecItem({
  label,
  value,
  highlight = false,
  span = false,
}: {
  label: string;
  value: string | null | undefined;
  highlight?: boolean;
  span?: boolean;
}) {
  return (
    <div className={span ? "col-span-2 sm:col-span-3" : ""}>
      <dt className="text-xs text-gray-400">{label}</dt>
      <dd
        className={`mt-0.5 text-sm font-semibold ${
          highlight ? "text-gray-900 text-base" : "text-gray-700"
        }`}
      >
        {value ?? <span className="text-gray-300 font-normal">—</span>}
      </dd>
    </div>
  );
}
