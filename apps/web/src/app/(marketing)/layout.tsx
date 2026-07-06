import MarketingNav from "@/components/marketing/MarketingNav";
import MarketingFooter from "@/components/marketing/MarketingFooter";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="marketing-light min-h-screen">
      <MarketingNav />
      <main>{children}</main>
      <MarketingFooter />
    </div>
  );
}
