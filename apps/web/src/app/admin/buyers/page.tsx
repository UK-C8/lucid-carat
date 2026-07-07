import { redirect } from "next/navigation";
import { getSession } from "@/lib/withSession";
import Nav from "@/components/Nav";

export default async function BuyersPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav user={{ fullName: session.fullName, email: session.email, role: session.role }} />
      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Buyers</h1>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-2xl mb-3">👥</p>
          <p className="text-gray-500 text-sm font-medium mb-1">Buyers & CRM — Coming Soon</p>
          <p className="text-gray-400 text-xs max-w-sm mx-auto">
            Manage buyer accounts, segments, inquiries, and quotes here. This feature is currently in development.
          </p>
        </div>
      </main>
    </div>
  );
}
