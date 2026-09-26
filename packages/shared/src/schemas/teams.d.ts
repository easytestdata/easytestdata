import { z } from "zod";

export declare const inviteSchema: z.ZodObject<{
  /** Trimmed and lowercased before validation. */
  email: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodString>;
  role: z.ZodDefault<z.ZodEnum<{ admin: "admin"; member: "member" }>>;
}>;

export declare const switchTeamSchema: z.ZodObject<{ teamId: z.ZodString }>;

/** POST /teams/invites/accept: the invite token travels in the body, never in the URL (logs). */
export declare const acceptInviteSchema: z.ZodObject<{ token: z.ZodString }>;
