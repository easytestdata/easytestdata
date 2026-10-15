import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";

export interface ExtensionRoute {
  path: string;
  element: ComponentType | LazyExoticComponent<ComponentType>;
}

export interface ExtensionNavItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

export interface BrandMetadata {
  name: string;
  description: string;
  repoUrl: string | null;
  supportsSourceReads: boolean;
  companionUrl?: string;
  companionLabel?: string;
}

export interface WebExtensions {
  logo?: ComponentType<{ className?: string }>;
  // Paths must be unique within each list and must not overlap /, /home,
  // /settings, /setup, /login, /invite or /admin (including their child routes).
  routes: ExtensionRoute[];
  navItems: ExtensionNavItem[];
}
