// FR-10, BR-5: Buyer-facing stone detail with React Three Fiber 3D viewer.
// Price-book scoping is enforced by the /api/catalog/[id] route:
//   - RLS scopes to tenant
//   - WHERE buyer_id = session.userId scopes to this buyer
//   - A different buyer cannot reach this page and see another buyer's price
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import CatalogStoneDetail from "./CatalogStoneDetail";

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

async function getStone(id: string): Promise<CatalogStone | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("lc_session");
  if (!sessionCookie) return null;

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/catalog/${id}`, {
    headers: { Cookie: `lc_session=${sessionCookie.value}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

interface PassportSummary {
  event_count: number;
  head_hash: string | null;
  valid: boolean;
  validation_detail: string;
}

async function getPassportSummary(id: string): Promise<PassportSummary | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("lc_session");
  if (!sessionCookie) return null;

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/stones/${id}/passport`, {
    headers: { Cookie: `lc_session=${sessionCookie.value}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.validation ?? null;
}

export default async function CatalogStonePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [stone, passport] = await Promise.all([getStone(id), getPassportSummary(id)]);

  if (!stone) notFound();

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <CatalogStoneDetail stone={stone} passportSummary={passport} />
    </div>
  );
}
