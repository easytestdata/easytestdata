import { z } from "zod";

// A job carries its whole configuration; the server normalizes and validates `config` against
// core's bounds (services/scenario-config.js) before building any plan.
const templateId = z.string().min(1);
const config = z.record(z.string(), z.unknown()).default({});

export const createJobSchema = z.object({
  type: z.enum(["generate", "export", "load", "purge"]),
  connectionId: z.string().uuid().optional(),
  templateId,
  config
});

export const estimateJobSchema = z.object({ templateId, config });

export const JOB_TYPES = /** @type {const} */ (["generate", "load", "purge", "export", "rollback"]);

export const JOB_STATUSES = /** @type {const} */ ([
  "pending",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "failed_with_orphans"
]);
