import { z } from "zod";

const canonicalEmailSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.string().email()
);

export const inviteSchema = z.object({
  email: canonicalEmailSchema,
  role: z.enum(["admin", "member"]).default("member")
});

export const switchTeamSchema = z.object({
  teamId: z.string().uuid("Invalid team id")
});

/** POST /teams/invites/accept: the invite token travels in the body, never in the URL (logs). */
export const acceptInviteSchema = z.object({
  token: z.string().min(1, "Invite token is required").max(512)
});
