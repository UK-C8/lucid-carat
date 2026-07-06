// Widget layout: no navigation, no auth wrapper.
// Resets body to transparent so the widget can sit on any background.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Diamond Verification — LucidCarat",
  robots: "noindex",
};

export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { background: transparent; margin: 0; padding: 12px; display: flex; justify-content: center; }
        input:focus { border-color: #3b82f6 !important; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
      `}</style>
      {children}
    </>
  );
}
