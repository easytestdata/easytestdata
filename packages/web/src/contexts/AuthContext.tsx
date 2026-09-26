import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setSentryUser } from "./SentryContext";
import { useAppConfig } from "./AppConfigContext";
import * as api from "../api/client";

interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

interface AuthState {
  user: User | null;
  teamId: string | null;
  loading: boolean;
  isAdmin: boolean;
  logout: () => void;
  exchangeOAuthCode: (code: string) => Promise<void>;
  /** Switches the session to another team the user belongs to (new tokens). */
  switchTeam: (teamId: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const binary = atob(`${normalized}${"=".repeat(padding)}`);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function readStringClaim(token: string | null | undefined, claim: "teamId" | "sub") {
  if (!token) return null;

  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(payloadSegment)) as Record<string, unknown>;
    const value = payload[claim];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function readTeamIdFromAccessToken(token: string | null | undefined): string | null {
  return readStringClaim(token, "teamId");
}

export function readUserIdFromAccessToken(token: string | null | undefined): string | null {
  return readStringClaim(token, "sub");
}

export function shouldClearSessionAfterProfileError(error: unknown): boolean {
  return error instanceof api.ApiError && [401, 403, 404].includes(error.status);
}

/**
 * Clears the react-query cache whenever the session's user or team changes (team switch, invite
 * accept, a refresh that fell back to another team, logout, another account signing in), so no
 * view shows the previous team's cached data. The first value is the initial load, not a change.
 */
export function useClearQueryCacheOnSessionChange(userId: string | null, teamId: string | null) {
  const queryClient = useQueryClient();
  const previous = useRef<string | null | undefined>(undefined);
  const key = userId && teamId ? `${userId}:${teamId}` : null;
  useEffect(() => {
    if (previous.current !== undefined && previous.current !== key) {
      queryClient.clear();
    }
    previous.current = key;
  }, [key, queryClient]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const { deployment, loading: configLoading } = useAppConfig();
  useClearQueryCacheOnSessionChange(user?.id ?? null, teamId);

  /** Loads the profile of the account the current token belongs to into the session state. */
  const loadProfile = useCallback(
    () =>
      api
        .getProfile()
        .then((profile) => {
          setUser({
            id: profile.id,
            email: profile.email,
            displayName: profile.display_name,
            avatarUrl: profile.avatar_url
          });
          setIsAdmin(profile.is_admin === true);
          // teamId is encoded in the JWT; local mode has no token, the profile carries it.
          setTeamId(readTeamIdFromAccessToken(api.getAccessToken()) ?? profile.team_id ?? null);
        })
        .catch((error) => {
          if (shouldClearSessionAfterProfileError(error)) {
            api.logout();
          }
        }),
    []
  );

  const initialized = useRef(false);
  useEffect(() => {
    // Which mode this is decides everything below, so wait for /config/public.
    if (configLoading || initialized.current) return;
    initialized.current = true;

    // Local mode: no sign-in and no tokens; the server answers as the one built-in user.
    if (deployment === "local") {
      loadProfile().finally(() => setLoading(false));
      return;
    }

    // If returning from OAuth callback, clear stale session so the
    // exchange effect in LoginPage starts fresh (prevents loading an
    // old user's profile for the wrong account).
    const params = new URLSearchParams(window.location.search);
    if (params.has("auth_code")) {
      api.clearTokens();
      setLoading(false);
      return;
    }

    if (!api.isAuthenticated()) {
      setLoading(false);
      return;
    }
    loadProfile().finally(() => setLoading(false));
  }, [configLoading, deployment, loadProfile]);

  // Keep the session in sync with whatever token is current (refresh fallback, invite accept,
  // switch). Tokens for a different account (another tab signed in as someone else) replace the
  // whole user state, not just the team: name and admin status are per account. Tokens cleared
  // by the API client (a refresh the server rejected, e.g. after "sign out everywhere") sign
  // out here too, so protected routes send the user to the login page. Tokens another tab stored
  // or cleared arrive here too (`fromOtherTab`); a signed-out tab then signs in as that account.
  // Local mode has no tokens.
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;
  const deploymentRef = useRef(deployment);
  deploymentRef.current = deployment;
  useEffect(() => {
    const onTokens = (event: Event) => {
      const fromOtherTab = (event as CustomEvent).detail?.fromOtherTab === true;
      const token = api.getAccessToken();
      if (!token) {
        if (deploymentRef.current === "local") return;
        setUser(null);
        setTeamId(null);
        setIsAdmin(false);
        setSentryUser(null);
        return;
      }
      const nextUser = readUserIdFromAccessToken(token);
      // Same tab, signed out: the sign-in flow sets the user itself.
      if (nextUser && (userIdRef.current || fromOtherTab) && nextUser !== userIdRef.current) {
        void loadProfile();
        return;
      }
      const next = readTeamIdFromAccessToken(token);
      if (next) setTeamId(next);
    };
    window.addEventListener(api.TOKENS_CHANGED_EVENT, onTokens);
    return () => window.removeEventListener(api.TOKENS_CHANGED_EVENT, onTokens);
  }, []);

  // Sentry identification (runs when user/team change)
  useEffect(() => {
    if (!user) return;
    setSentryUser({ id: user.id, email: user.email, teamId });
  }, [user, teamId]);

  const handleAuthResponse = useCallback((data: api.AuthResponse) => {
    setUser(data.user);
    setTeamId(data.teamId);
    // Sentry identification handled by the dedicated effect above
    // Fetch profile to get is_admin (not included in auth response)
    api
      .getProfile()
      .then((profile) => {
        setIsAdmin(profile.is_admin === true);
      })
      .catch(() => {});
  }, []);

  const logoutFn = useCallback(() => {
    api.logout();
    setUser(null);
    setTeamId(null);
    setSentryUser(null);
  }, []);

  const exchangeOAuthCodeFn = useCallback(
    async (code: string) => {
      const data = await api.exchangeOAuthCode(code);
      handleAuthResponse(data);
    },
    [handleAuthResponse]
  );

  const switchTeamFn = useCallback(
    async (nextTeamId: string) => {
      const data = await api.switchTeam(nextTeamId);
      handleAuthResponse(data);
    },
    [handleAuthResponse]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        teamId,
        loading,
        isAdmin,
        logout: logoutFn,
        exchangeOAuthCode: exchangeOAuthCodeFn,
        switchTeam: switchTeamFn
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
