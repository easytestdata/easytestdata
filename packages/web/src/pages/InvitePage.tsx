import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { acceptTeamInvite } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Alert,
  AlertDescription
} from "@easytestdata/ui";
import { AlertCircle, Loader2, RefreshCw, Users } from "lucide-react";

export function InvitePage() {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = searchParams.get("token") || "";
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");
  const startedRef = useRef(false);

  const acceptInvite = useCallback(async () => {
    if (!token || !user || startedRef.current) return;
    startedRef.current = true;
    setAccepting(true);
    setError("");

    try {
      // The response carries tokens for the joined team (stored by the client), so the UI is
      // now working in that team: drop every cached query from the previous team.
      await acceptTeamInvite(token);
      queryClient.clear();
      toast.success("Invitation accepted — you are now working in the new team");
      navigate("/settings/team", { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to accept invitation";
      startedRef.current = false;
      setError(message);
      toast.error(message);
    } finally {
      setAccepting(false);
    }
  }, [navigate, queryClient, token, user]);

  useEffect(() => {
    if (loading) return;
    if (!token) {
      setError("Invalid or missing invite token.");
      return;
    }
    if (!user) {
      navigate(`/login?invite_token=${encodeURIComponent(token)}`, { replace: true });
      return;
    }
    acceptInvite();
  }, [loading, user, token, navigate, acceptInvite]);

  if (loading || accepting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 via-slate-50 to-gray-100 p-4">
        <Card className="w-full max-w-md rounded-2xl shadow-xl">
          <CardContent className="p-6 text-center">
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground">Accepting invitation...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 via-slate-50 to-gray-100 p-4">
        <Card className="w-full max-w-md rounded-2xl shadow-xl">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle>Invite could not be accepted</CardTitle>
            <CardDescription>Please verify your invite link and try again.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            {user && token ? (
              <Button className="w-full" onClick={acceptInvite}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Try Again
              </Button>
            ) : null}
            <Button
              className="w-full"
              variant={user && token ? "outline" : "default"}
              onClick={() => navigate(user ? "/settings/team" : "/login", { replace: true })}
            >
              {user ? "Go to Team Settings" : "Back to Login"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 via-slate-50 to-gray-100 p-4">
      <Card className="w-full max-w-md rounded-2xl shadow-xl">
        <CardContent className="p-6 text-center">
          <Users className="mx-auto mb-3 h-8 w-8 text-primary" />
          <p className="text-muted-foreground">Preparing your team invitation...</p>
        </CardContent>
      </Card>
    </div>
  );
}
