import { toast } from "sonner";
import { rollbackJob } from "@easytestdata/shared/api-client";
import type { Job } from "../../types";

/**
 * Starts rolling back a load that stopped with records left in QuickBooks and says so either way
 * (a refusal carries the server's reason, e.g. "This load has already been rolled back.").
 * Returns the new rollback job, or null when none started.
 */
export async function startRollback(loadJobId: string): Promise<Job | null> {
  try {
    const job = (await rollbackJob(loadJobId)) as Job;
    toast.success("Rolling back the records this load created...");
    return job;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Could not start the roll back");
    return null;
  }
}
