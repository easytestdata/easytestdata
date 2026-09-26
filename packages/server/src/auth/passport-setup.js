import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import { IntuitSSOStrategy } from "./passport-intuit-sso.js";
import { config } from "../config.js";

let configured = false;

// Every strategy maps its provider profile to one normalized shape:
//   { provider, providerId, email, emailVerified, linkByEmail, displayName, avatarUrl }
// `emailVerified` is true only when the provider itself asserts that the user controls the
// address. `linkByEmail` says whether that assertion is trustworthy enough to attach the login
// to an existing account with the same email (see upsertOAuthUser in routes/auth.js).

function isTrue(value) {
  return value === true || value === "true";
}

export function mapGoogleProfile(profile) {
  const primary = profile.emails?.[0];
  const emailVerified = Boolean(primary?.value) && isTrue(primary?.verified);
  return {
    provider: "google",
    providerId: String(profile.id),
    email: primary?.value || null,
    emailVerified,
    linkByEmail: emailVerified,
    displayName: profile.displayName || profile.username || "Google User",
    avatarUrl: profile.photos?.[0]?.value || null
  };
}

/** GitHub: only the primary address, and only when GitHub reports it as verified. */
export function mapGithubProfile(profile) {
  const primary = (profile.emails || []).find((item) => isTrue(item.primary));
  const emailVerified = Boolean(primary?.value) && isTrue(primary?.verified);
  return {
    provider: "github",
    providerId: String(profile.id),
    email: primary?.value || null,
    emailVerified,
    linkByEmail: emailVerified,
    displayName: profile.displayName || profile.username || "GitHub User",
    avatarUrl: profile.photos?.[0]?.value || null
  };
}

export function mapIntuitProfile(profile) {
  const primary = profile.emails?.[0];
  const emailVerified = Boolean(primary?.value) && isTrue(primary?.verified);
  return {
    provider: "intuit",
    providerId: String(profile.id),
    email: primary?.value || null,
    emailVerified,
    linkByEmail: emailVerified,
    displayName: profile.displayName || "Intuit User",
    avatarUrl: profile.photos?.[0]?.value || null
  };
}

export function setupPassportStrategies() {
  if (configured) return;

  if (config.oauth.google.clientId && config.oauth.google.clientSecret) {
    passport.use(
      "google",
      new GoogleStrategy(
        {
          clientID: config.oauth.google.clientId,
          clientSecret: config.oauth.google.clientSecret,
          callbackURL: `${config.appUrl}/api/v1/auth/google/callback`
        },
        (accessToken, refreshToken, profile, done) => done(null, mapGoogleProfile(profile))
      )
    );
  }

  if (config.oauth.github.clientId && config.oauth.github.clientSecret) {
    passport.use(
      "github",
      new GitHubStrategy(
        {
          clientID: config.oauth.github.clientId,
          clientSecret: config.oauth.github.clientSecret,
          callbackURL: `${config.appUrl}/api/v1/auth/github/callback`,
          scope: ["user:email"],
          // Return every address with its primary/verified flags from the /user/emails API.
          allRawEmails: true
        },
        (accessToken, refreshToken, profile, done) => done(null, mapGithubProfile(profile))
      )
    );
  }

  if (config.oauth.intuit.clientId && config.oauth.intuit.clientSecret) {
    passport.use(
      "intuit",
      new IntuitSSOStrategy(
        {
          clientID: config.oauth.intuit.clientId,
          clientSecret: config.oauth.intuit.clientSecret,
          callbackURL: `${config.appUrl}/api/v1/auth/intuit/callback`,
          scope: ["openid", "profile", "email"]
        },
        (accessToken, refreshToken, profile, done) => done(null, mapIntuitProfile(profile))
      )
    );
  }

  configured = true;
}
