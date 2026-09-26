import { useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useAppConfig } from "../contexts/AppConfigContext";
import { Home, Settings, Menu, LogOut, ChevronDown, Shield, CodeXml } from "lucide-react";
import {
  BrandLogo,
  cn,
  Button,
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SandboxBadge,
  REPO_URL
} from "@easytestdata/ui";

const NAV_ITEMS = [
  { path: "/home", label: "Home", icon: Home },
  { path: "/settings", label: "Settings", icon: Settings }
] as const;

function getInitials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function Layout() {
  const { user, logout, isAdmin } = useAuth();
  // Local mode has one built-in user: nothing to sign out of.
  const canSignOut = useAppConfig().deployment !== "local";
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  function isActive(path: string) {
    return path === "/settings"
      ? location.pathname.startsWith("/settings")
      : location.pathname === path;
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Desktop top nav */}
      <header className="hidden lg:flex h-14 items-center border-b bg-background px-6">
        {/* Left: Brand */}
        <Link to="/home" className="flex items-center gap-2 mr-8">
          <BrandLogo className="h-7 w-7" />
          <span className="text-lg font-bold">EasyTestData</span>
        </Link>

        {/* Center-left: Nav links */}
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
          {isAdmin && (
            <Link
              to="/admin"
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                location.pathname.startsWith("/admin")
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              <Shield className="h-4 w-4" />
              Admin
            </Link>
          )}
        </nav>

        {/* Right: Sandbox badge + user dropdown */}
        <div className="ml-auto flex items-center gap-3">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="EasyTestData is open source under Apache-2.0"
          >
            <CodeXml className="h-4 w-4" />
            Open source
          </a>
          <SandboxBadge />
          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent">
                  <Avatar className="h-7 w-7">
                    <AvatarImage src={user.avatarUrl ?? undefined} />
                    <AvatarFallback className="bg-primary/20 text-xs text-primary">
                      {getInitials(user.displayName)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden xl:inline max-w-[120px] truncate font-medium">
                    {user.displayName}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem disabled>
                  <span className="truncate">{user.email}</span>
                </DropdownMenuItem>
                {canSignOut && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleLogout}>
                      <LogOut className="mr-2 h-4 w-4" />
                      Sign out
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {/* Mobile header + sheet */}
      <header className="flex h-14 items-center gap-4 border-b bg-background px-4 lg:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 bg-sidebar p-0">
            <div className="flex h-full flex-col">
              <SheetHeader className="h-16 px-6">
                <SheetTitle className="flex items-center gap-2 text-sidebar-foreground">
                  <BrandLogo className="h-8 w-8" />
                  EasyTestData
                </SheetTitle>
              </SheetHeader>
              <div className="px-6 pb-3">
                <SandboxBadge />
              </div>
              <nav className="flex-1 overflow-auto py-4 px-3 space-y-1">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.path);
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
                {isAdmin && (
                  <Link
                    to="/admin"
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors mt-2 pt-2 border-t border-sidebar-border",
                      location.pathname.startsWith("/admin")
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    )}
                  >
                    <Shield className="h-4 w-4" />
                    Admin
                  </Link>
                )}
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                >
                  <CodeXml className="h-4 w-4" />
                  Open source (Apache-2.0)
                </a>
              </nav>
              {user && (
                <div className="border-t border-sidebar-border p-3">
                  <div className="flex items-center gap-3 rounded-lg px-3 py-2">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={user.avatarUrl ?? undefined} />
                      <AvatarFallback className="bg-primary/20 text-xs text-primary">
                        {getInitials(user.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-sidebar-foreground">
                        {user.displayName}
                      </p>
                      <p className="truncate text-xs text-sidebar-foreground/60">{user.email}</p>
                    </div>
                  </div>
                  {canSignOut && (
                    <Button
                      variant="ghost"
                      className="mt-1 w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                      onClick={() => {
                        setMobileOpen(false);
                        handleLogout();
                      }}
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      Sign out
                    </Button>
                  )}
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
        <span className="text-lg font-bold">EasyTestData</span>
        <div className="ml-auto">
          <SandboxBadge />
        </div>
      </header>

      {/* Main content area — full width */}
      <main className="flex-1 overflow-auto bg-background">
        <div className="mx-auto max-w-6xl animate-fade-in p-6 lg:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
