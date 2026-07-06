import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";

const GRADING_URL = process.env.GRADING_SERVICE_URL ?? "http://localhost:8001";

export async function GET(
  req: NextRequest
) {
  try { await requireSession(); }
  catch { return unauthorized(); }

  const jobId = req.nextUrl.searchParams.get("job_id");
  if (!jobId) return NextResponse.json({ error: "job_id required" }, { status: 400 });

  const statusResp = await fetch(`${GRADING_URL}/grading/jobs/${jobId}`);
  if (!statusResp.ok) {
    return NextResponse.json({ error: "Job not found" }, { status: statusResp.status });
  }
  const status = await statusResp.json();

  // If completed, also fetch full result
  if (status.status === "completed") {
    const resultResp = await fetch(`${GRADING_URL}/grading/jobs/${jobId}/result`);
    if (resultResp.ok) {
      const result = await resultResp.json();
      return NextResponse.json({ ...status, result });
    }
  }

  return NextResponse.json(status);
}
