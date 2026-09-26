/**
 * Centralized React-Query key factory.
 * packages/web imports from here for consistent cache keys.
 */
export const queryKeys = {
  connections: {
    all: ["connections"],
    health: (id) => ["connections", id, "health"]
  },
  jobs: {
    all: ["jobs"],
    detail: (id) => ["jobs", id],
    data: (id) => ["jobs", id, "data"]
  },
  templates: {
    industries: ["templates", "industries"],
    presets: ["templates", "presets"]
  },
  teams: {
    all: ["teams"],
    members: (teamId) => ["teams", teamId, "members"]
  },
  // Under "jobs" so every job change (which invalidates ["jobs"]) refreshes it too.
  usage: ["jobs", "usage"]
};

// Keep polling while a job can still change on its own: a cancelling job drains its batches and
// then ends as cancelled or failed_with_orphans.
export const ACTIVE_JOB_STATUSES = ["pending", "running", "cancelling"];
