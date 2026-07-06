// Development test page simulating an external site embedding the verify widget.
// In production a tenant would embed:
//   <iframe src="https://app.lucidcarat.com/widget/{stone_id}" ...></iframe>
export default function WidgetTestPage() {
  return (
    <div style={{ fontFamily: "Georgia, serif", background: "#faf7f4", minHeight: "100vh", padding: "40px 20px" }}>
      <style>{`
        body { background: #faf7f4 !important; }
        .embed-snippet { background: #1e1e2e; color: #a8b3d1; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
      `}</style>
      <div style={{ maxWidth: 700, margin: "0 auto" }}>
        <h1 style={{ fontSize: 28, color: "#2d1b00", marginBottom: 8 }}>Acme Jewellers</h1>
        <p style={{ color: "#7c6044", fontStyle: "italic", marginBottom: 32 }}>
          Certified diamonds sourced directly from trusted Indian houses
        </p>

        <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginBottom: 32 }}>
          <div style={{ width: 280, height: 280, background: "linear-gradient(135deg,#e8ddd0,#d4c4b0)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 48, flexShrink: 0 }}>
            💎
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <h2 style={{ fontSize: 20, marginBottom: 8 }}>2.01 ct Round Brilliant — D / IF</h2>
            <p style={{ color: "#5a4030", lineHeight: 1.6, marginBottom: 16 }}>
              A rare D colour, Internally Flawless round brilliant cut diamond certified by GIA.
              Ideal proportions with Excellent cut, polish, and symmetry.
            </p>
            <p style={{ fontWeight: "bold" }}>Price: $15,000</p>
          </div>
        </div>

        <div style={{ marginBottom: 32 }}>
          <h3 style={{ fontFamily: "system-ui, sans-serif", fontSize: 14, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 12 }}>
            Independent Provenance Verification
          </h3>
          <iframe
            src="/widget/f50a07cc-beec-47d9-8637-58df8a4994de"
            title="Diamond provenance verification"
            height="500"
            width="420"
            style={{ border: "none", display: "block" }}
          />
        </div>

        <div>
          <p style={{ fontFamily: "system-ui,sans-serif", fontSize: 12, color: "#7c6044", marginBottom: 6 }}>
            Embed this widget on your site:
          </p>
          <div className="embed-snippet">{`<iframe
  src="https://app.lucidcarat.com/widget/f50a07cc-beec-47d9-8637-58df8a4994de"
  title="Diamond provenance verification"
  width="420"
  height="480"
  frameborder="0"
  scrolling="no"
></iframe>`}</div>
        </div>
      </div>
    </div>
  );
}
