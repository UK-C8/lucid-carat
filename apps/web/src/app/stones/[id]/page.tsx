import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/withSession";
import { query } from "@/lib/db";
import StoneDetail from "./StoneDetail";

export default async function StonePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;

  const stones = await query<Record<string, unknown>>(
    `SELECT s.*, c.id AS cert_id, c.lab, c.cert_number, c.carat_weight AS cert_carat,
            c.shape AS cert_shape, c.color_grade, c.clarity_grade, c.cut_grade,
            c.polish, c.symmetry, c.fluorescence, c.measurements_mm,
            c.depth_pct, c.table_pct, c.lab_grown AS cert_lab_grown,
            c.low_confidence_fields, c.issued_date
     FROM stones s
     LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE s.id = $1 AND s.tenant_id = $2`,
    [id, session.tenantId]
  );

  if (!stones.length) notFound();
  const stone = stones[0];

  // Fetch current grading result
  const grading = await query<Record<string, unknown>>(
    `SELECT id, source, model_version, color_grade, clarity_grade, cut_grade,
            color_confidence, clarity_confidence, cut_confidence,
            color_disagrees_with_cert, clarity_disagrees_with_cert, cut_disagrees_with_cert,
            created_at
     FROM grading_results
     WHERE stone_id = $1 AND is_current = true`,
    [id]
  );

  // Fetch current price forecast
  const forecast = await query<Record<string, unknown>>(
    `SELECT id, model_version, fair_price_usd, confidence_low_usd, confidence_high_usd,
            confidence_level, top_drivers, markup_pct, adjusted_by, adjusted_at,
            adjustment_note, created_at
     FROM price_forecasts
     WHERE stone_id = $1 AND is_current = true`,
    [id]
  );

  const initialStone = {
    ...stone,
    grading: grading[0] ?? null,
    forecast: forecast[0] ?? null,
  };

  return (
    <div>
      <div className="mb-6">
        <Link href="/stones" className="text-sm text-gray-500 hover:text-gray-900">
          ← Stones
        </Link>
      </div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <StoneDetail initialStone={initialStone as any} />
    </div>
  );
}
