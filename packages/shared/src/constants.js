// A limit of -1 means unlimited. Compare limits with isUnlimited()/allowsAny()/withinLimit()
// rather than `limit > 0` so unlimited deployments are never treated as "not allowed".
export const UNLIMITED = -1;

/**
 * Abuse limits by deployment. EasyTestData is free everywhere: EasyTestData Cloud caps each team
 * so one tenant cannot monopolize the shared service, and local mode (`npx easytestdata ui`) has
 * no limits.
 */
export const DEPLOYMENT_LIMITS = {
  cloud: {
    connections: 3,
    // Only loads into QuickBooks count; downloads, removals and roll backs are free.
    loadsPerMonth: 10,
    entitiesPerJob: 5000,
    teamMembers: 5
  },
  local: {
    connections: -1,
    loadsPerMonth: -1,
    entitiesPerJob: -1,
    teamMembers: -1
  }
};

/** Human wording for each limit, used in error messages. */
export const LIMIT_LABELS = {
  connections: "QuickBooks connections per team",
  loadsPerMonth: "loads into QuickBooks per month",
  entitiesPerJob: "records per job",
  teamMembers: "members per team"
};

/**
 * The message shown when an EasyTestData Cloud limit is reached, e.g.
 * "EasyTestData Cloud allows up to 5,000 records per job. Run it locally for no limits."
 */
export function limitExceededMessage(kind, limit) {
  const label = LIMIT_LABELS[kind] || kind;
  return `EasyTestData Cloud allows up to ${Number(limit).toLocaleString("en-US")} ${label}. Run it locally for no limits.`;
}

/** True when a limit means "no limit". */
export function isUnlimited(limit) {
  return limit === UNLIMITED;
}

/** True when a limit allows at least one of something (unlimited counts). */
export function allowsAny(limit) {
  return isUnlimited(limit) || (typeof limit === "number" && limit > 0);
}

/** True when `used` is still below `limit` (unlimited counts). */
export function withinLimit(used, limit) {
  return isUnlimited(limit) || used < limit;
}
