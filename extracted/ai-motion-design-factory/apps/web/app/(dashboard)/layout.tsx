import Link from "next/link";
import { UserMenu } from "@/components/auth/UserMenu";
import {
  LayoutGrid,
  Clapperboard,
  Globe,
  Users,
  Send,
  Handshake,
  Receipt,
  BookOpen,
  BarChart3,
  Radio,
} from "lucide-react";

const NAV = [
  { href: "/studio", label: "Studio", icon: Clapperboard },
  { href: "/portfolio", label: "Portfolio", icon: Globe },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/campaigns", label: "Campaigns", icon: Send },
  { href: "/deals", label: "Deals", icon: Handshake },
  { href: "/billing", label: "Billing", icon: Receipt },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/control-room", label: "Control Room", icon: Radio },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-hairline bg-panel">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-4">
          <LayoutGrid className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold tracking-tight">Motion Factory</span>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2.5 rounded px-2.5 py-2 text-sm text-ink-muted transition-colors hover:bg-panel-raised hover:text-ink-primary"
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="space-y-2 border-t border-hairline px-4 py-3">
          <span className="kbd">⌘K</span>
          <UserMenu />
        </div>
      </aside>

      <main className="flex-1 bg-void">{children}</main>
    </div>
  );
}
