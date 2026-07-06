// FR-8, BR-4: Export Diamond Passport as JSON or PDF.
// ?format=json (default) | ?format=pdf
//
// The PDF is a verifiable document: it includes the full event chain,
// each event's hash, chain-head hash, and validation status.
// The disclaimer "Grades are decision aids, not official GIA/IGI certificates"
// is included as required by CLAUDE.md §14.
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { getPassportChain, validateChain } from "@/lib/passport";
import { queryAsTenant } from "@/lib/db";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.STONE_VIEW);
  if (denied) return denied;

  const { id: stoneId } = await params;
  const format = req.nextUrl.searchParams.get("format") ?? "json";

  // Stone + cert details.
  const stones = await queryAsTenant<{
    internal_ref: string;
    status: string;
    shape: string | null;
    carat_weight: string | null;
    confirmed_color: string | null;
    confirmed_clarity: string | null;
    confirmed_cut: string | null;
    lab_grown: boolean | null;
    cert_number: string | null;
    lab: string | null;
  }>(
    session.tenantId,
    `SELECT s.internal_ref, s.status, s.shape, s.carat_weight,
            s.confirmed_color, s.confirmed_clarity, s.confirmed_cut, s.lab_grown,
            c.cert_number, c.lab
     FROM stones s
     LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE s.id = $1`,
    [stoneId]
  );

  if (!stones.length) {
    return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  }

  const stone = stones[0];
  const events = await getPassportChain(session.tenantId, stoneId);
  const validation = validateChain(events);
  const headHash = events.length ? events[events.length - 1].event_hash : null;
  const exportedAt = new Date().toISOString();

  // ── JSON export ─────────────────────────────────────────────────────────────
  const passport = {
    schema_version: "1.0",
    exported_at: exportedAt,
    stone: {
      id: stoneId,
      internal_ref: stone.internal_ref,
      status: stone.status,
      shape: stone.shape,
      carat_weight: stone.carat_weight,
      confirmed_color: stone.confirmed_color,
      confirmed_clarity: stone.confirmed_clarity,
      confirmed_cut: stone.confirmed_cut,
      lab_grown: stone.lab_grown,
      cert_number: stone.cert_number,
      lab: stone.lab,
    },
    chain: {
      event_count: events.length,
      head_hash: headHash,
      valid: validation.valid,
      validation_detail: validation.detail,
    },
    events: events.map((e) => ({
      seq: e.seq,
      id: e.id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      location: e.location,
      payload: e.payload,
      prev_event_hash: e.prev_event_hash,
      event_hash: e.event_hash,
    })),
    disclaimer:
      "LucidCarat grades are computer-vision decision aids only — " +
      "not official GIA/IGI certificates. Chain integrity proves " +
      "tamper-evidence of this record; it does not constitute proof " +
      "of real-world origin.",
  };

  if (format !== "pdf") {
    return new NextResponse(JSON.stringify(passport, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="passport-${stone.internal_ref}.json"`,
      },
    });
  }

  // ── PDF export ──────────────────────────────────────────────────────────────
  const doc = await PDFDocument.create();
  const pageW = 595, pageH = 842; // A4
  let page = doc.addPage([pageW, pageH]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const col = { title: rgb(0.11, 0.16, 0.27), valid: rgb(0.1, 0.55, 0.2), invalid: rgb(0.8, 0.1, 0.1), dim: rgb(0.4, 0.4, 0.4), black: rgb(0,0,0) };
  let y = pageH - 48;

  function text(s: string, x: number, size: number, f = font, color = col.black) {
    if (y < 60) { page = doc.addPage([pageW, pageH]); y = pageH - 48; }
    page.drawText(s, { x, y, size, font: f, color });
    y -= size + 4;
  }
  function line() {
    page.drawLine({ start: { x: 40, y: y + 6 }, end: { x: pageW - 40, y: y + 6 }, thickness: 0.5, color: col.dim });
    y -= 8;
  }

  // Title
  text("Diamond Passport", 40, 22, bold, col.title);
  text(`LucidCarat · ${exportedAt.slice(0, 10)}`, 40, 9, font, col.dim);
  y -= 6; line();

  // Stone header
  text(`Stone: ${stone.internal_ref}  |  ${stone.shape ?? "-"}  |  ${stone.carat_weight ?? "-"} ct`, 40, 11, bold);
  text(`Grades:  Color ${stone.confirmed_color ?? "-"}  |  Clarity ${stone.confirmed_clarity ?? "-"}  |  Cut ${stone.confirmed_cut ?? "-"}`, 40, 10);
  if (stone.cert_number) text(`Cert: ${stone.lab ?? ""} ${stone.cert_number}`, 40, 10);
  if (stone.lab_grown) text("[LAB-GROWN]  Lab-grown diamond", 40, 10, font, col.invalid);
  y -= 4; line();

  // Chain summary
  const chainLabel = validation.valid ? "[VALID]  Chain valid" : "[TAMPERED]  Chain integrity failure";
  const chainColor = validation.valid ? col.valid : col.invalid;
  text(chainLabel, 40, 11, bold, chainColor);
  text(validation.detail, 40, 9, font, col.dim);
  if (headHash) text(`Head hash: ${headHash}`, 40, 8, mono, col.dim);
  y -= 4; line();

  // Events table header
  text("Provenance Events", 40, 11, bold);
  y -= 2;

  for (const ev of events) {
    if (y < 100) { page = doc.addPage([pageW, pageH]); y = pageH - 48; }
    const evTs = new Date(ev.occurred_at).toISOString().slice(0, 19).replace("T", " ");
    text(`[${ev.seq}] ${ev.event_type.replace(/_/g, " ").toUpperCase()}  --  ${evTs}`, 40, 9, bold);
    if (ev.location) text(`     Location: ${ev.location}`, 40, 8, font, col.dim);
    const payloadStr = JSON.stringify(ev.payload);
    if (payloadStr !== "{}") text(`     ${payloadStr.slice(0, 90)}`, 40, 8, font, col.dim);
    text(`     Hash: ${ev.event_hash}`, 40, 7, mono, col.dim);
    y -= 2;
  }

  line();
  y -= 4;
  // Disclaimer (mandatory per CLAUDE.md §14)
  const disclaimer = "Grades are computer-vision decision aids only - not official GIA/IGI certificates.";
  const disclaimer2 = "Chain integrity proves tamper-evidence of this record; it does not prove real-world origin.";
  text(disclaimer, 40, 7, font, col.dim);
  text(disclaimer2, 40, 7, font, col.dim);

  const bytes = await doc.save();

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="passport-${stone.internal_ref}.pdf"`,
    },
  });
}
