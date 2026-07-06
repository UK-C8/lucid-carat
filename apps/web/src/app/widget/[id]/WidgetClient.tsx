"use client";

// FR-10, BR-5: Client interactivity for the verify widget.
// Handles lead form submission and lead_submitted analytics (CLAUDE.md §11).

import { useState } from "react";

interface WidgetData {
  stone: {
    id: string;
    internal_ref: string;
    shape: string | null;
    carat_weight: string | null;
    confirmed_color: string | null;
    confirmed_clarity: string | null;
    confirmed_cut: string | null;
    lab_grown: boolean;
    fluorescence: string | null;
    polish: string | null;
    symmetry: string | null;
    status: string;
  };
  certificate: { lab: string | null; cert_number: string } | null;
  passport: {
    event_count: number;
    chain_valid: boolean;
    head_hash: string | null;
  };
  verified_by: {
    tenant_name: string;
    platform: string;
  };
  disclaimer: string;
}

export default function WidgetClient({ data }: { data: WidgetData }) {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submitLead() {
    if (!email.trim()) return;
    setBusy(true);
    await fetch(`/api/verify/${data.stone.id}/lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => {});
    setSubmitted(true);
    setBusy(false);
  }

  const { stone, certificate, passport, verified_by } = data;
  const shape = stone.shape?.replace(/_/g, " ") ?? "Diamond";

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 14,
        color: "#1a1a2e",
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
        maxWidth: 420,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)",
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ color: "#94a3b8", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Diamond Verified
          </div>
          <div style={{ color: "#fff", fontWeight: 700, fontSize: 16, marginTop: 2 }}>
            {stone.carat_weight ? `${stone.carat_weight} ct` : stone.internal_ref}{" "}
            <span style={{ fontWeight: 400, color: "#cbd5e1" }}>{shape}</span>
          </div>
          {stone.lab_grown && (
            <div style={{ color: "#fbbf24", fontSize: 11, marginTop: 2 }}>
              Lab-grown diamond
            </div>
          )}
        </div>
        {/* Diamond icon */}
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
          <polygon points="18,4 32,14 27,32 9,32 4,14" fill="none" stroke="#60a5fa" strokeWidth="1.5"/>
          <polygon points="18,4 32,14 18,13" fill="#1e40af" opacity="0.6"/>
          <polygon points="18,4 4,14 18,13" fill="#1d4ed8" opacity="0.7"/>
          <polygon points="4,14 9,32 18,13" fill="#2563eb" opacity="0.5"/>
          <polygon points="32,14 27,32 18,13" fill="#3b82f6" opacity="0.5"/>
          <polygon points="9,32 27,32 18,13" fill="#60a5fa" opacity="0.4"/>
        </svg>
      </div>

      {/* 4Cs grid */}
      <div style={{ padding: "16px 20px 0" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "10px 20px",
            marginBottom: 14,
          }}
        >
          <Spec label="Color" value={stone.confirmed_color} />
          <Spec label="Clarity" value={stone.confirmed_clarity} />
          <Spec label="Cut" value={stone.confirmed_cut} />
          <Spec label="Carat" value={stone.carat_weight ? `${stone.carat_weight} ct` : null} />
          {stone.fluorescence && <Spec label="Fluorescence" value={stone.fluorescence} />}
          {stone.polish && <Spec label="Polish" value={stone.polish} />}
        </div>

        {/* Certificate row */}
        {certificate && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 0",
              borderTop: "1px solid #f1f5f9",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#10b981",
                flexShrink: 0,
              }}
            />
            <span style={{ color: "#374151", fontSize: 13 }}>
              <strong>{certificate.lab}</strong> certificate matched —{" "}
              <span style={{ color: "#6b7280", fontFamily: "monospace", fontSize: 12 }}>
                {certificate.cert_number}
              </span>
            </span>
          </div>
        )}

        {/* Passport chain row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 0",
            borderTop: "1px solid #f1f5f9",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: passport.chain_valid ? "#10b981" : "#ef4444",
              flexShrink: 0,
            }}
          />
          <span style={{ color: "#374151", fontSize: 13 }}>
            {passport.chain_valid ? (
              <>
                Provenance chain <strong>verified</strong> —{" "}
                {passport.event_count} event{passport.event_count !== 1 ? "s" : ""}
              </>
            ) : (
              <strong style={{ color: "#ef4444" }}>Chain integrity issue detected</strong>
            )}
          </span>
        </div>
      </div>

      {/* Lead CTA */}
      <div
        style={{
          padding: "14px 20px",
          background: "#f8fafc",
          borderTop: "1px solid #e5e7eb",
        }}
      >
        {submitted ? (
          <p style={{ color: "#10b981", fontSize: 13, margin: 0, fontWeight: 500 }}>
            Thank you — we will be in touch shortly.
          </p>
        ) : (
          <>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "#374151" }}>
              Interested in this stone? Contact {verified_by.tenant_name}:
            </p>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitLead()}
                style={{
                  flex: 1,
                  padding: "7px 10px",
                  border: "1px solid #d1d5db",
                  borderRadius: 6,
                  fontSize: 13,
                  outline: "none",
                }}
                aria-label="Email address"
              />
              <button
                onClick={submitLead}
                disabled={busy || !email.trim()}
                style={{
                  padding: "7px 14px",
                  background: "#1e40af",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: email.trim() && !busy ? "pointer" : "not-allowed",
                  opacity: email.trim() && !busy ? 1 : 0.6,
                }}
              >
                {busy ? "…" : "Inquire"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Disclaimer + branding */}
      <div
        style={{
          padding: "10px 20px",
          borderTop: "1px solid #e5e7eb",
          background: "#f8fafc",
        }}
      >
        <p
          style={{
            margin: "0 0 6px",
            fontSize: 10,
            color: "#9ca3af",
            lineHeight: 1.5,
          }}
        >
          {data.disclaimer}
        </p>
        <p style={{ margin: 0, fontSize: 10, color: "#9ca3af" }}>
          Verified by{" "}
          <a
            href="https://lucidcarat.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#3b82f6", textDecoration: "none" }}
          >
            LucidCarat
          </a>{" "}
          &middot; Powered by{" "}
          <a
            href="https://centr8.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#3b82f6", textDecoration: "none" }}
          >
            Centr8
          </a>
        </p>
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div style={{ fontWeight: 600, color: "#111827", marginTop: 2, fontSize: 15 }}>
        {value ?? "—"}
      </div>
    </div>
  );
}
