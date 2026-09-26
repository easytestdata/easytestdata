import { useParams, useNavigate, Navigate } from "react-router-dom";
import { User, Users, Info } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@easytestdata/ui";
import { AccountSection } from "@/components/settings/AccountSection";
import { TeamSection } from "@/components/settings/TeamSection";
import { AboutSection } from "@/components/settings/AboutSection";
import { useAppConfig } from "@/contexts/AppConfigContext";

const SECTIONS = [
  { id: "account", label: "Account", icon: User },
  { id: "team", label: "Team", icon: Users },
  { id: "about", label: "About", icon: Info }
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  // Local mode has one built-in user and team: no Team section.
  const local = useAppConfig().deployment === "local";
  const sections = local ? SECTIONS.filter((s) => s.id !== "team") : SECTIONS;

  const activeSection = (section ?? "account") as SectionId;
  if (!sections.some((s) => s.id === activeSection)) {
    return <Navigate to="/settings" replace />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Manage your account, team, and preferences." />

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Sidebar navigation */}
        <nav className="flex gap-1 overflow-x-auto lg:w-48 lg:flex-col lg:overflow-visible">
          {sections.map((s) => {
            const Icon = s.icon;
            const active = activeSection === s.id;
            return (
              <button
                key={s.id}
                onClick={() => navigate(s.id === "account" ? "/settings" : `/settings/${s.id}`)}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {s.label}
              </button>
            );
          })}
        </nav>

        {/* Content area */}
        <div className="min-w-0 flex-1">
          {activeSection === "account" && <AccountSection />}
          {activeSection === "team" && <TeamSection />}
          {activeSection === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
