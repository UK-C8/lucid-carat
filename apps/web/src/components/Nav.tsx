"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface NavProps {
  user: { fullName: string; email: string; role: string } | null;
}

export default function Nav({ user }: NavProps) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <Link href="/stones" className="font-bold text-gray-900 text-sm">
          💎 LucidCarat
        </Link>
        <Link
          href="/stones"
          className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
        >
          Stones
        </Link>
        <Link
          href="/stones/new"
          className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
        >
          + New Stone
        </Link>
        {(user?.role === "admin" || user?.role === "sales") && (
          <Link
            href="/catalog"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Catalog
          </Link>
        )}
        {(user?.role === "admin" || user?.role === "sales") && (
          <Link
            href="/admin/price-books"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Price Books
          </Link>
        )}
        {(user?.role === "admin" || user?.role === "sales") && (
          <Link
            href="/admin/buyers"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Buyers
          </Link>
        )}
        {user?.role === "buyer" && (
          <Link
            href="/catalog"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Catalog
          </Link>
        )}
        {user?.role === "admin" && (
          <Link
            href="/billing"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Billing
          </Link>
        )}
      </div>

      {user && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {user.fullName} <span className="text-gray-400">({user.role})</span>
          </span>
          <button
            onClick={logout}
            disabled={loggingOut}
            className="text-xs text-gray-500 hover:text-gray-900 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
