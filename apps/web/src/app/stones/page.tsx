import Link from "next/link";
import { getSession } from "@/lib/withSession";
import { query } from "@/lib/db";
import { redirect } from "next/navigation";

const STATUS_COLORS: Record<string, string> = {
  uploaded: "bg-gray-100 text-gray-600",
  grading: "bg-yellow-100 text-yellow-700",
  priced: "bg-green-100 text-green-700",
  published: "bg-blue-100 text-blue-700",
  sold: "bg-purple-100 text-purple-700",
  archived: "bg-gray-100 text-gray-400",
};

export default async function StonesPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const stones = await query<{
    id: string;
    internal_ref: string | null;
    status: string;
    shape: string | null;
    carat_weight: string | null;
    lab_grown: string;
    cert_number: string | null;
    lab: string | null;
    color_grade: string | null;
    clarity_grade: string | null;
    cut_grade: string | null;
    created_at: string;
  }>(
    `SELECT s.id, s.internal_ref, s.status, s.shape, s.carat_weight, s.lab_grown,
            c.cert_number, c.lab, c.color_grade, c.clarity_grade, c.cut_grade,
            s.created_at
     FROM stones s
     LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE s.tenant_id = $1
     ORDER BY s.created_at DESC
     LIMIT 100`,
    [session.tenantId]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Stones</h1>
        <Link
          href="/stones/new"
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          + Upload Stone
        </Link>
      </div>

      {stones.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <p className="text-gray-400 text-sm">No stones yet.</p>
          <Link
            href="/stones/new"
            className="mt-4 inline-block text-blue-600 text-sm hover:underline"
          >
            Upload your first stone →
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Ref</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Cert #</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">4Cs</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stones.map((s) => (
                <tr key={s.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-gray-700 font-mono text-xs">
                    {s.internal_ref ?? s.id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {s.cert_number ? (
                      <span className="font-mono text-xs">
                        {s.lab} {s.cert_number}
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {s.carat_weight && (
                      <span className="text-xs">
                        {s.carat_weight}ct ·{" "}
                        {[s.color_grade, s.clarity_grade, s.cut_grade]
                          .filter(Boolean)
                          .join(" / ")}
                        {s.lab_grown === "yes" && (
                          <span className="ml-1 text-xs text-purple-500">[LG]</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                        STATUS_COLORS[s.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {new Date(s.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/stones/${s.id}`}
                      className="text-blue-600 text-xs hover:underline"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
