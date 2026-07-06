import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.STONE_VIEW);
  if (denied) return denied;

  const { id } = await params;

  const stones = await queryAsTenant(
    session.tenantId,
    `SELECT s.*, c.id AS cert_id, c.lab, c.cert_number, c.carat_weight AS cert_carat,
            c.shape AS cert_shape, c.color_grade, c.clarity_grade, c.cut_grade,
            c.polish, c.symmetry, c.fluorescence, c.measurements_mm,
            c.depth_pct, c.table_pct, c.lab_grown AS cert_lab_grown,
            c.low_confidence_fields, c.issued_date
     FROM stones s
     LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE s.id = $1`,
    [id]
  );

  if (!stones.length) {
    return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  }

  const stone = stones[0] as Record<string, unknown>;

  const grading = await queryAsTenant(
    session.tenantId,
    `SELECT id, source, model_version, color_grade, clarity_grade, cut_grade,
            color_confidence, clarity_confidence, cut_confidence,
            color_disagrees_with_cert, clarity_disagrees_with_cert, cut_disagrees_with_cert,
            created_at
     FROM grading_results
     WHERE stone_id = $1 AND is_current = true`,
    [id]
  );

  const forecast = await queryAsTenant(
    session.tenantId,
    `SELECT id, model_version, fair_price_usd, confidence_low_usd, confidence_high_usd,
            confidence_level, top_drivers, markup_pct, adjusted_by, adjusted_at,
            adjustment_note, created_at
     FROM price_forecasts
     WHERE stone_id = $1 AND is_current = true`,
    [id]
  );

  return NextResponse.json({
    ...stone,
    grading: grading[0] ?? null,
    forecast: forecast[0] ?? null,
  });
}
