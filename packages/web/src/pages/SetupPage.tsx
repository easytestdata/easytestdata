import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label
} from "@easytestdata/ui";
import { AlertCircle, Copy, ExternalLink, Loader2 } from "lucide-react";
import { authorizeConnection, request } from "../api/client";
import { useAppConfig } from "../contexts/AppConfigContext";

interface SetupStatus {
  qboConfigured: boolean;
  redirectUri: string;
}

/**
 * Local mode, first connect: the user pastes their Intuit developer app's keys. The server stores
 * them encrypted; generating and downloading files never needs them.
 */
export function SetupPage() {
  const navigate = useNavigate();
  const { refresh, qboRedirectUri } = useAppConfig();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    request<SetupStatus>("GET", "/setup")
      .then((data) => active && setStatus(data))
      // The app config carries the same redirect URI: use it rather than spin forever.
      .catch(() => active && setStatusFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const redirectUri = status?.redirectUri || (statusFailed ? qboRedirectUri : "") || "";
  const redirectUriLoading = !status && !statusFailed;

  async function copyRedirectUri() {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      toast.success("Redirect URI copied");
    } catch {
      toast.error("Could not copy. Select the address and copy it manually.");
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await request("PUT", "/setup/qbo", { clientId, clientSecret });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the keys.");
      setSaving(false);
      return;
    }
    try {
      await refresh();
    } catch {
      // Saved, but the app still has the old settings: going home would offer setup again.
      setError(
        "The keys were saved, but the app could not reload its settings. Reload the page to continue."
      );
      setSaving(false);
      return;
    }
    // Go straight on to Intuit: sending the user home would only make them click Connect again.
    try {
      const data = await authorizeConnection("redirect");
      if (data?.url) {
        toast.success("Intuit keys saved. Opening Intuit to connect a sandbox...");
        window.location.href = data.url;
        return;
      }
    } catch {
      // Fall through: the keys are saved, so the home page's Connect button works.
    }
    toast.success("Intuit keys saved. Click Connect QuickBooks Sandbox to continue.");
    navigate("/home");
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Connect QuickBooks: add your Intuit keys</CardTitle>
          <CardDescription>
            To load data into a QuickBooks Online sandbox, EasyTestData needs the keys of your own
            Intuit developer app. You only do this once; the keys stay on this computer, encrypted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Create an app at{" "}
              <a
                href="https://developer.intuit.com/app/developer/dashboard"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                developer.intuit.com
                <ExternalLink className="h-3 w-3" />
              </a>{" "}
              with the QuickBooks Online Accounting scope.
            </li>
            <li>Add this redirect URI to the app&apos;s development settings:</li>
          </ol>

          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
            {redirectUri ? (
              <code className="flex-1 break-all font-mono text-sm">{redirectUri}</code>
            ) : redirectUriLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <span className="flex-1 text-sm text-muted-foreground">
                Could not load the redirect URI. Reload the page to try again.
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyRedirectUri}
              disabled={!redirectUri}
              aria-label="Copy redirect URI"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <p className="text-sm">Then paste the app&apos;s development (sandbox) keys:</p>
            <div className="grid gap-2">
              <Label htmlFor="qbo-client-id" className="leading-6">
                Client ID
              </Label>
              <Input
                id="qbo-client-id"
                autoComplete="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="qbo-client-secret" className="leading-6">
                Client Secret
              </Label>
              <Input
                id="qbo-client-secret"
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                required
                maxLength={200}
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex items-center justify-between gap-3">
              <Button type="button" variant="ghost" asChild>
                <Link to="/home">Back</Link>
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save and connect
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
