import { Shield } from "lucide-react";
import { Badge } from "./ui/badge";

export function SandboxBadge() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-emerald-300 bg-emerald-50 text-emerald-700 text-xs font-medium"
    >
      <Shield className="h-3 w-3" />
      Sandbox only
    </Badge>
  );
}
