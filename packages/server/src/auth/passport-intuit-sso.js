import { Strategy as OAuth2Strategy } from "passport-oauth2";
import { logger } from "../logger.js";

const AUTHORIZATION_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const USERINFO_SANDBOX = "https://sandbox-accounts.platform.intuit.com/v1/openid_connect/userinfo";
const USERINFO_PRODUCTION = "https://accounts.platform.intuit.com/v1/openid_connect/userinfo";

function buildProfile(json) {
  return {
    provider: "intuit",
    id: json.sub,
    displayName: [json.givenName, json.familyName].filter(Boolean).join(" ") || "Intuit User",
    emails: json.email ? [{ value: json.email, verified: json.emailVerified }] : [],
    photos: json.picture ? [{ value: json.picture }] : []
  };
}

/**
 * Profile from the id_token of the token exchange (unverified decode: the token came straight
 * from Intuit's token endpoint over TLS in this same request, so it is trusted as much as the
 * access token next to it). Returns null when there is no usable id_token.
 */
export function profileFromIdToken(idToken) {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    return payload?.sub ? buildProfile(payload) : null;
  } catch {
    return null;
  }
}

/**
 * Intuit OpenID Connect login. The profile comes from the userinfo endpoint; when that fails,
 * from the id_token of the token exchange. passport-oauth2 hands a 5-arity verify callback the
 * token-exchange `params` of the request being verified, so the fallback stays per request:
 * nothing about a login is ever stored on the shared strategy instance, and two interleaved
 * logins cannot see each other's id_token.
 */
export class IntuitSSOStrategy extends OAuth2Strategy {
  constructor(options, verify) {
    const sandbox = options.sandbox !== false; // default to sandbox
    super(
      {
        authorizationURL: AUTHORIZATION_URL,
        tokenURL: TOKEN_URL,
        ...options
      },
      (accessToken, refreshToken, params, profile, done) => {
        const resolved = profile || profileFromIdToken(params?.id_token);
        if (!resolved) {
          logger.error("Could not get Intuit user profile from userinfo or id_token");
          return done(new Error("Could not retrieve Intuit user profile"));
        }
        return verify(accessToken, refreshToken, resolved, done);
      }
    );
    this.name = "intuit";
    this._userinfoURL = sandbox ? USERINFO_SANDBOX : USERINFO_PRODUCTION;
    // Use Authorization header (not query string) for API calls
    this._oauth2.useAuthorizationHeaderforGET(true);
  }

  userProfile(accessToken, done) {
    this._oauth2.get(this._userinfoURL, accessToken, (err, body) => {
      if (!err && body) {
        try {
          const json = JSON.parse(body);
          if (json.sub) {
            return done(null, buildProfile(json));
          }
        } catch {
          // fall through to the id_token of this request (see the verify wrapper)
        }
      }
      done(null, null);
    });
  }
}
