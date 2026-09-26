import { z } from "zod";

export declare const createJobSchema: z.ZodObject<{
  type: z.ZodEnum<{ generate: "generate"; export: "export"; load: "load"; purge: "purge" }>;
  connectionId: z.ZodOptional<z.ZodString>;
  templateId: z.ZodString;
  config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}>;

export declare const estimateJobSchema: z.ZodObject<{
  templateId: z.ZodString;
  config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}>;

export declare const JOB_TYPES: readonly ["generate", "load", "purge", "export", "rollback"];

export declare const JOB_STATUSES: readonly [
  "pending",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "failed_with_orphans"
];
