import { redirect } from "next/navigation";
import { getSession } from "@/lib/withSession";
import Nav from "@/components/Nav";

export default async function StonesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav
        user={{
          fullName: session.fullName,
          email: session.email,
          role: session.role,
        }}
      />
      <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
