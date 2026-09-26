import { useState, useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { LayoutDashboard, Users, Briefcase, Plug, Menu, ChevronLeft, LogOut } from "lucide-react";
import {
  cn,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@easytestdata/ui";
import { useAdminHotkeys } from "@/hooks/useAdminHotkeys";

const ADMIN_NAV_ITEMS = [
  { path: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { path: "/admin/users", label: "Users", icon: Users },
  { path: "/admin/jobs", label: "Jobs", icon: Briefcase },
  { path: "/admin/connections", label: "Connections", icon: Plug }
];

function AdminNavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {ADMIN_NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.exact ? pathname === item.path : pathname.startsWith(item.path);
        return (
          <Link
            key={item.path}
            to={item.path}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AdminLayout() {
  const { isAdmin } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  useAdminHotkeys();

  // Redirect non-admins
  useEffect(() => {
    if (isAdmin === false) navigate("/home", { replace: true });
  }, [isAdmin, navigate]);

  if (!isAdmin) return null;

  return (
    <div className="flex h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-56 flex-col border-r bg-card lg:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Link
            to="/home"
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="text-xs font-medium">Back to App</span>
          </Link>
        </div>
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Admin Panel</h2>
        </div>
        <div className="flex-1 overflow-auto py-1">
          <AdminNavLinks pathname={location.pathname} />
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-14 items-center gap-3 border-b bg-card px-4">
          {/* Mobile menu */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-56 bg-card p-0">
              <SheetHeader className="h-14 border-b px-4">
                <SheetTitle className="text-sm">Admin Panel</SheetTitle>
              </SheetHeader>
              <div className="py-2">
                <AdminNavLinks
                  pathname={location.pathname}
                  onNavigate={() => setMobileOpen(false)}
                />
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex-1" />

          {/* Back to app */}
          <Link to="/home">
            <Button
              variant="ghost"
              size="sm"
              className="hidden lg:flex text-xs text-muted-foreground"
            >
              <LogOut className="h-3.5 w-3.5 mr-1.5" />
              Exit Admin
            </Button>
          </Link>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl p-4 lg:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
