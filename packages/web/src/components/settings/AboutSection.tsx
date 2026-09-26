import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  BrandLogo,
  REPO_URL,
  SandboxBadge
} from "@easytestdata/ui";
import { CLIENT_HEADERS } from "@easytestdata/shared/api-client";
import { useAppConfig } from "@/contexts/AppConfigContext";

const RESOURCES = [
  { label: "GitHub repository", href: REPO_URL },
  { label: "Run it locally", href: `${REPO_URL}/blob/main/docs/run-locally.md` },
  { label: "Documentation (README)", href: `${REPO_URL}#readme` },
  { label: "Report an issue", href: `${REPO_URL}/issues` }
];

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function AboutSection() {
  const { version, deployment, qboConfigured, qboRedirectUri } = useAppConfig();
  const local = deployment === "local";
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/config/public", { headers: CLIENT_HEADERS })
      .then((res) => !cancelled && setApiReachable(res.ok))
      .catch(() => !cancelled && setApiReachable(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const modeLabel = local ? "Local" : "EasyTestData Cloud";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>About EasyTestData</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <BrandLogo className="h-8 w-8" />
            <div>
              <h3 className="font-semibold">EasyTestData</h3>
              <p className="text-sm text-muted-foreground">
                Realistic test data for QuickBooks Online sandboxes.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{modeLabel}</Badge>
            <SandboxBadge />
          </div>
          <p className="text-sm text-muted-foreground">
            EasyTestData only connects to QuickBooks Online (QBO) sandbox companies. QBO API calls
            are hard-coded to the sandbox endpoint, so this {local ? "app" : "service"} never
            connects to a production company. EasyTestData is open source under the Apache 2.0
            license.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <InfoRow label="Version">
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-sm">
              {version ?? "unknown"}
            </code>
          </InfoRow>
          <InfoRow label="Server URL">
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-sm">
              {window.location.origin}
            </code>
          </InfoRow>
          <InfoRow label="API status">
            <Badge
              variant={apiReachable === false ? "destructive" : "outline"}
              className={
                apiReachable === null
                  ? "text-muted-foreground"
                  : apiReachable
                    ? "border-green-500 text-green-600"
                    : ""
              }
            >
              {apiReachable === null ? "Checking..." : apiReachable ? "Reachable" : "Unreachable"}
            </Badge>
          </InfoRow>
          <InfoRow label="Mode">
            <Badge variant="outline">{modeLabel}</Badge>
          </InfoRow>
          <InfoRow label="QBO connection setup">
            <Badge
              variant="outline"
              className={
                qboConfigured
                  ? "border-green-500 text-green-600"
                  : "border-amber-500 text-amber-700"
              }
            >
              {qboConfigured ? "Configured" : "Not configured"}
            </Badge>
          </InfoRow>
          {local && qboRedirectUri && (
            <div className="space-y-1 rounded-lg border bg-muted/40 p-3">
              <p className="text-sm font-medium">Intuit OAuth redirect URI</p>
              <p className="text-xs text-muted-foreground">
                Register this exact URI in your Intuit developer app (sandbox keys).
                {!qboConfigured && " Then add the app's keys on the setup page (Connect a sandbox)."}
              </p>
              <code className="block break-all rounded bg-background px-2 py-1 font-mono text-sm">
                {qboRedirectUri}
              </code>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {RESOURCES.map((r) => (
            <Button
              key={r.href}
              variant="ghost"
              className="w-full justify-start gap-2 px-2"
              asChild
            >
              <a href={r.href} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 shrink-0" />
                {r.label}
              </a>
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
