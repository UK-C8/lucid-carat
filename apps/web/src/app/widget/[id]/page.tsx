// FR-10, BR-5: Embeddable "Verify this diamond" widget page.
// Designed to be embedded as an iframe on third-party tenant websites.
// X-Frame-Options removed via next.config.mjs headers so any origin can embed it.
// No auth required — reads only publicly visible (published/sold) stones.
import { notFound } from "next/navigation";
import WidgetClient from "./WidgetClient";

interface VerifyData {
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
  verified_by: { tenant_name: string; platform: string };
  disclaimer: string;
}

async function getVerifyData(id: string): Promise<VerifyData | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/verify/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

export default async function WidgetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getVerifyData(id);
  if (!data) notFound();

  return <WidgetClient data={data} />;
}
