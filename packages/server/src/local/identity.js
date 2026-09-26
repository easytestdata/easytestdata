import { transaction } from "../db/pool.js";
import { resolveSessionTeam, sessionVersionOf } from "../auth/session.js";

// The one built-in user of local mode. It never signs in: `authenticate` attaches it to every
// request. The provider pair identifies it; no sign-in route is mounted in local mode.
const LOCAL_USER = {
  email: "local@easytestdata.local",
  displayName: "Local user",
  provider: "local",
  providerId: "local"
};

let identity = null;

/** Ensures the one local user + team exist; caches { id, email, teamId, sessionVersion }. */
export async function ensureLocalIdentity() {
  identity = await transaction(async (client) => {
    await client.query(
      `INSERT INTO users (email, display_name, oauth_provider, oauth_provider_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [LOCAL_USER.email, LOCAL_USER.displayName, LOCAL_USER.provider, LOCAL_USER.providerId]
    );
    const { rows } = await client.query(
      `SELECT id, email, display_name, session_version FROM users
       WHERE oauth_provider = $1 AND oauth_provider_id = $2
       FOR NO KEY UPDATE`,
      [LOCAL_USER.provider, LOCAL_USER.providerId]
    );
    const user = rows[0];
    if (!user) throw new Error(`${LOCAL_USER.email} exists but is not the local user`);
    // Its own team, also made the active team (the same helper sign-in uses in Cloud).
    const { teamId } = await resolveSessionTeam(user.id, user.display_name, client);
    return {
      id: user.id,
      email: user.email,
      teamId,
      sessionVersion: sessionVersionOf(user)
    };
  });
  return identity;
}

/** The local user and team; ensureLocalIdentity() must have run (start.js does it at startup). */
export function getLocalIdentity() {
  if (!identity) throw new Error("Local identity not initialized: call ensureLocalIdentity()");
  return identity;
}
