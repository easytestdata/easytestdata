// Shared domain types used by the web API client.
// UI-specific types (QboConnection, Job, etc.) remain in @easytestdata/ui.

export interface PublicConfigBase {
  /** "cloud" (sign-in, abuse limits) or "local" (`npx easytestdata ui`: one built-in user). */
  deployment: "cloud" | "local";
  /** Server package version, shown in Settings > About. */
  version: string | null;
  /** False when the server has no Intuit app keys (environment, or local mode's setup page). */
  qboConfigured: boolean;
  /** Redirect URI to register in the Intuit developer app. */
  qboRedirectUri: string;
  /** The marketing site (MARKETING_URL), which also hosts the Terms and Privacy pages. */
  marketingUrl: string;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
  teamId: string;
  accessToken: string;
  refreshToken: string;
}
