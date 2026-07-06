// FR-6, BR-3: Buyer-facing catalog page.
// Server component — fetches catalog via the existing API which enforces
// buyer_id scoping and RLS, so each buyer sees only their assigned stones.
import { cookies } from "next/headers";
import Link from "next/link";

interface CatalogEntry {
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
}

async function getCatalog(): Promise<CatalogEntry[]> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("lc_session");
  if (!sessionCookie) return [];

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/catalog`, {
    headers: { Cookie: `lc_session=${sessionCookie.value}` },
    cache: "no-store",
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function CatalogPage() {
  const stones = await getCatalog();

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Your Diamond Catalog</h1>
      <p className="text-sm text-gray-500 mb-6">
        {stones.length} stone{stones.length !== 1 ? "s" : ""} available to you
      </p>

      {stones.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500">No stones have been assigned to your account yet.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stones.map((s) => (
            <Link
              key={s.stone_id}
              href={`/catalog/${s.stone_id}`}
              className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-blue-200 transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wide">
                    {s.shape?.replace(/_/g, " ") ?? "Diamond"}
                  </p>
                  <p className="font-semibold text-gray-900 mt-0.5">{s.internal_ref}</p>
                </div>
                {s.is_stale && !s.is_hard_blocked && (
                  <span className="text-xs bg-amber-50 text-amber-600 px-2 py-0.5 rounded">
                    Price pending refresh
                  </span>
                )}
              </div>

              <div className="flex gap-4 text-sm mb-4">
                <Grade label="Color" value={s.confirmed_color} />
                <Grade label="Clarity" value={s.confirmed_clarity} />
                <Grade label="Cut" value={s.confirmed_cut} />
                {s.carat_weight && (
                  <Grade label="Carat" value={`${s.carat_weight} ct`} />
                )}
              </div>

              <div className="flex items-center justify-between">
                {s.is_hard_blocked ? (
                  <span className="text-sm text-gray-400 italic">Price unavailable</span>
                ) : s.effective_price_usd ? (
                  <span className="text-lg font-bold text-gray-900">
                    ${Number(s.effective_price_usd).toLocaleString()}
                  </span>
                ) : (
                  <span className="text-sm text-gray-400">—</span>
                )}
                <span className="text-xs text-blue-600 group-hover:underline">
                  View &amp; 3D →
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Grade({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="font-medium text-gray-800">{value ?? "—"}</p>
    </div>
  );
}
