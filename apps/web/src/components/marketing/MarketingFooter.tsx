import Link from "next/link";

export default function MarketingFooter() {
  return (
    <footer className="bg-lc-surface border-t border-lc-border mt-24">
      <div className="max-w-6xl mx-auto px-6 py-16 grid grid-cols-1 md:grid-cols-4 gap-10">
        <div className="md:col-span-2">
          <div className="flex items-center gap-2 font-semibold text-lc-text text-sm mb-3">
            <span className="text-lc-blue text-lg">◆</span>
            LucidCarat
          </div>
          <p className="text-sm text-lc-muted max-w-xs leading-relaxed">
            AI-assisted grading, forecast-backed pricing, and tamper-evident
            provenance for diamond houses — built by Centr8 LLP.
          </p>
          <p className="text-xs text-lc-muted mt-4">
            LucidCarat grades are a decision aid. They are not GIA/IGI
            certificates and carry no legal or gemological certification status.
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold text-lc-muted uppercase tracking-widest mb-4">Product</p>
          <ul className="space-y-2 text-sm text-lc-muted">
            <li><Link href="/#features" className="hover:text-lc-text transition-colors">Features</Link></li>
            <li><Link href="/#how-it-works" className="hover:text-lc-text transition-colors">How it works</Link></li>
            <li><Link href="/pricing" className="hover:text-lc-text transition-colors">Pricing</Link></li>
            <li><Link href="/docs/api-reference" className="hover:text-lc-text transition-colors">API reference</Link></li>
          </ul>
        </div>

        <div>
          <p className="text-xs font-semibold text-lc-muted uppercase tracking-widest mb-4">Company</p>
          <ul className="space-y-2 text-sm text-lc-muted">
            <li>
              <a href="https://centr8.io" target="_blank" rel="noopener noreferrer" className="hover:text-lc-text transition-colors">
                Centr8 LLP
              </a>
            </li>
            <li><Link href="/login" className="hover:text-lc-text transition-colors">Sign in</Link></li>
          </ul>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs text-lc-muted border-t border-lc-border pt-6">
        <span>© {new Date().getFullYear()} Centr8 LLP. All rights reserved.</span>
        <span className="text-lc-muted/60">
          Provenance chain integrity does not constitute proof of real-world origin.
        </span>
      </div>
    </footer>
  );
}
