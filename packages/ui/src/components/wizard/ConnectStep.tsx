import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { TrustBanner } from "../TrustBanner";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Badge } from "../ui/badge";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  AlertTriangle,
  Link2,
  CheckCircle2,
  Loader2,
  Unlink,
  PlugZap,
  Plus,
  Download,
  ExternalLink
} from "lucide-react";
import { OAuthFlowSvg } from "../svg/OAuthFlowSvg";
import { cn } from "../../lib/utils";
import type { QboConnection } from "../../types";

/** How a connection's stored-token health reads in the list (the server rates it by age). */
export function describeTokenHealth(tokenHealth: QboConnection["tokenHealth"]) {
  if (tokenHealth === "expired") {
    return {
      expired: true,
      label: "Expired",
      badgeVariant: "destructive" as const,
      iconClass: "bg-red-100"
    };
  }
  if (tokenHealth === "warning") {
    return {
      expired: false,
      label: "Token expiring soon",
      badgeVariant: "warning" as const,
      iconClass: "bg-amber-100"
    };
  }
  return {
    expired: false,
    label: "Connected",
    badgeVariant: "success" as const,
    iconClass: "bg-emerald-100"
  };
}

interface ConnectStepProps {
  connections: QboConnection[];
  onConnected: () => void;
  onSkipToGenerate?: () => void;
  onDeleteConnection: (id: string) => Promise<void>;
  onTestConnection: (id: string) => Promise<{ ok: boolean; companyName?: string; error?: string }>;
  onAuthorizeConnection: (mode?: "popup" | "redirect") => Promise<{ url: string }>;
  onConnectionsInvalidate: () => void;
  /**
   * False when the server has no Intuit app keys: in Cloud QBO_CLIENT_ID / QBO_CLIENT_SECRET are
   * unset; in local mode neither those nor keys saved on the setup page are available.
   */
  qboConfigured?: boolean;
  /** Connections the detailed health check found expired (e.g. unreadable stored tokens). */
  expiredConnectionIds?: Set<string>;
  /** Redirect URI to register in the Intuit developer app, shown when QBO is not configured. */
  qboRedirectUri?: string;
  /**
   * Local mode: where the Intuit keys are entered. Without keys, connecting opens this page
   * instead of the Intuit flow (and no server-configuration notice is shown).
   */
  setupHref?: string;
  /** Toast text for an error code the connect popup reports (e.g. connection_limit_reached). */
  describeConnectError?: (code: string) => string;
}

export function ConnectStep({
  connections,
  onConnected,
  onSkipToGenerate,
  onDeleteConnection,
  onTestConnection,
  onAuthorizeConnection,
  onConnectionsInvalidate,
  qboConfigured = true,
  expiredConnectionIds,
  qboRedirectUri,
  setupHref,
  describeConnectError
}: ConnectStepProps) {
  const [connecting, setConnecting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    popupRef.current = null;
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.connected) {
        toast.success("QuickBooks sandbox connected!");
        onConnectionsInvalidate();
      } else if (data.error) {
        toast.error(
          describeConnectError
            ? describeConnectError(String(data.error))
            : `Connection failed: ${data.error}`
        );
      }
      cleanup();
      setConnecting(false);
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      cleanup();
    };
  }, [cleanup, onConnectionsInvalidate, describeConnectError]);

  const hasConnection = connections.length > 0;
  // No Intuit keys yet, but this app can take them: "connect" goes to the setup page.
  const connectOpensSetup = !qboConfigured && Boolean(setupHref);

  async function handleConnect() {
    setConnecting(true);
    try {
      const data = await onAuthorizeConnection("popup");
      if (!data?.url) {
        setConnecting(false);
        return;
      }

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        data.url,
        "qbo_oauth",
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
      );

      if (!popup || popup.closed) {
        // Popup blocked — fall back to redirect
        window.location.href = data.url;
        return;
      }

      popupRef.current = popup;
      pollRef.current = setInterval(() => {
        if (popupRef.current?.closed) {
          cleanup();
          setConnecting(false);
        }
      }, 500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start connection");
      setConnecting(false);
    }
  }

  async function handleTest(id: string) {
    setTestingId(id);
    try {
      const data = await onTestConnection(id);
      if (data.ok) {
        toast.success(`Connected to ${data.companyName}`);
      } else {
        toast.error(data.error || "Connection test failed");
      }
    } catch {
      toast.error("Connection test failed");
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete() {
    if (!deleteId || deleting) return;
    setDeleting(true);
    try {
      await onDeleteConnection(deleteId);
      toast.success("Sandbox disconnected");
      setDeleteId(null);
    } catch (err) {
      // The server explains a refusal (e.g. a job is still running on this sandbox).
      toast.error(
        err instanceof Error && err.message ? err.message : "Failed to disconnect sandbox"
      );
    } finally {
      setDeleting(false);
    }
  }

  if (!hasConnection) {
    return (
      <div className="space-y-6">
        <TrustBanner variant="full" />

        <div className="text-center">
          <div className="mx-auto mb-6">
            <OAuthFlowSvg className="mx-auto w-full max-w-[200px]" />
          </div>
          <h2 className="text-xl font-semibold">Connect your QuickBooks Online sandbox</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Sign in with your Intuit developer account and pick the sandbox company to fill. Sandbox
            companies only: EasyTestData refuses any non-sandbox QuickBooks address, and Intuit
            development keys can only connect sandbox companies.
          </p>
          {connectOpensSetup ? (
            <Button
              asChild
              size="lg"
              className="mt-6 bg-gradient-to-br from-blue-600 to-cyan-500 text-white shadow-lg shadow-blue-500/25 hover:from-blue-700 hover:to-cyan-600"
            >
              <a href={setupHref}>
                <Link2 className="mr-2 h-4 w-4" />
                Connect QuickBooks Sandbox
              </a>
            </Button>
          ) : qboConfigured ? (
            <Button
              size="lg"
              className="mt-6 bg-gradient-to-br from-blue-600 to-cyan-500 text-white shadow-lg shadow-blue-500/25 hover:from-blue-700 hover:to-cyan-600"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              Connect QuickBooks Sandbox
            </Button>
          ) : (
            <div
              role="alert"
              className="mx-auto mt-6 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-4 text-left text-sm text-amber-900"
            >
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                QuickBooks Online is not configured on this server
              </p>
              <p className="mt-2">
                Create an app at developer.intuit.com, then set <code>QBO_CLIENT_ID</code> and{" "}
                <code>QBO_CLIENT_SECRET</code> to its sandbox (development) keys and restart the
                server.
              </p>
              {qboRedirectUri && (
                <p className="mt-2">
                  Register this redirect URI in the Intuit app:{" "}
                  <code className="break-all rounded bg-amber-100 px-1">{qboRedirectUri}</code>
                </p>
              )}
            </div>
          )}
          <div className="mt-4">
            <a
              href="https://developer.intuit.com/app/developer/sandbox"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              How to create a free QuickBooks sandbox company
            </a>
          </div>
        </div>

        {onSkipToGenerate && (
          <Card>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">No QuickBooks sandbox yet?</p>
                <p className="text-sm text-muted-foreground">
                  Generate a realistic company as JSON or CSV files to download.
                </p>
              </div>
              <Button variant="outline" onClick={onSkipToGenerate} className="shrink-0">
                <Download className="mr-2 h-4 w-4" />
                Make sample files instead
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <TrustBanner variant="compact" />

      {connections.map((conn) => {
        const health = describeTokenHealth(
          expiredConnectionIds?.has(conn.id) ? "expired" : conn.tokenHealth
        );
        return (
          <Card key={conn.id}>
            <CardContent className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full",
                    health.iconClass
                  )}
                >
                  {health.expired ? (
                    <AlertTriangle className="h-5 w-5 text-red-600" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  )}
                </div>
                <div>
                  <p className="font-medium">{conn.company_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {health.expired
                      ? "Click Reconnect and pick this company in Intuit before loading data."
                      : `Connected ${new Date(conn.connected_at).toLocaleDateString()}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={health.badgeVariant}>{health.label}</Badge>
                {health.expired && qboConfigured && (
                  <Button size="sm" onClick={handleConnect} disabled={connecting}>
                    Reconnect
                  </Button>
                )}
                {health.expired && connectOpensSetup && (
                  <Button size="sm" asChild>
                    <a href={setupHref}>Reconnect</a>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleTest(conn.id)}
                  disabled={testingId === conn.id}
                  aria-label={`Test ${conn.company_name} connection`}
                  title="Test connection"
                >
                  {testingId === conn.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PlugZap className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteId(conn.id)}
                  disabled={deleting}
                  aria-label={`Disconnect ${conn.company_name}`}
                  title="Disconnect"
                >
                  <Unlink className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <div className="flex items-center justify-between">
        {connectOpensSetup ? (
          <Button asChild variant="outline" size="sm">
            <a href={setupHref}>
              <Plus className="mr-2 h-3 w-3" />
              Add another sandbox
            </a>
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={handleConnect} disabled={connecting}>
            {connecting ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <Plus className="mr-2 h-3 w-3" />
            )}
            Add another sandbox
          </Button>
        )}
        <Button onClick={onConnected}>Continue to load data</Button>
      </div>

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Disconnect this sandbox?"
        description="EasyTestData forgets this sandbox and its tokens. Data already in QuickBooks stays. You can reconnect anytime."
        confirmLabel="Disconnect"
        onConfirm={handleDelete}
        destructive
        pending={deleting}
        pendingLabel="Disconnecting..."
      />
    </div>
  );
}
