"use client";
import Link from "next/link";
import { useState } from "react";

export default function MarketingNav() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="fixed top-0 inset-x-0 z-50 bg-white/95 backdrop-blur border-b border-lc-border shadow-sm">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold text-lc-text text-sm tracking-wide">
          <span className="text-lc-blue text-lg">◆</span>
          LucidCarat
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-8 text-sm text-lc-muted">
          <Link href="/#features" className="hover:text-lc-text transition-colors">Features</Link>
          <Link href="/#how-it-works" className="hover:text-lc-text transition-colors">How it works</Link>
          <Link href="/pricing" className="hover:text-lc-text transition-colors">Pricing</Link>
          <Link href="/docs/api-reference" className="hover:text-lc-text transition-colors">API docs</Link>
        </nav>

        <div className="hidden md:flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm text-lc-muted hover:text-lc-text transition-colors px-4 py-2"
          >
            Sign in
          </Link>
          <Link
            href="/#request-demo"
            className="text-sm bg-lc-blue hover:bg-lc-blue-light text-white font-semibold px-4 py-2 rounded transition-colors"
          >
            Request demo
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          className="md:hidden text-lc-muted hover:text-lc-text p-1"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {menuOpen
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            }
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div className="md:hidden bg-white border-t border-lc-border px-6 py-4 flex flex-col gap-4 text-sm text-lc-muted">
          <Link href="/#features" onClick={() => setMenuOpen(false)} className="hover:text-lc-text">Features</Link>
          <Link href="/#how-it-works" onClick={() => setMenuOpen(false)} className="hover:text-lc-text">How it works</Link>
          <Link href="/pricing" onClick={() => setMenuOpen(false)} className="hover:text-lc-text">Pricing</Link>
          <Link href="/docs/api-reference" onClick={() => setMenuOpen(false)} className="hover:text-lc-text">API docs</Link>
          <Link href="/login" onClick={() => setMenuOpen(false)} className="hover:text-lc-text">Sign in</Link>
          <Link
            href="/#request-demo"
            onClick={() => setMenuOpen(false)}
            className="bg-lc-blue text-white font-semibold px-4 py-2 rounded text-center"
          >
            Request demo
          </Link>
        </div>
      )}
    </header>
  );
}
