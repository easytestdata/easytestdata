// The schema declarations in src/schemas/*.d.ts are written by hand and ship with the package.
// `pnpm test` type-checks them against the installed zod so a zod upgrade cannot break them
// silently.
// Only type-checked, never run; the values are still ones the schemas accept.
import { z } from "zod";
import {
  acceptInviteSchema,
  createJobSchema,
  estimateJobSchema,
  inviteSchema,
  oauthCallbackSchema,
  oauthExchangeSchema,
  refreshSchema,
  switchTeamSchema
} from "../src/schemas/index.js";

type Job = z.infer<typeof createJobSchema>;
const job: Job = { type: "load", templateId: "saas", config: { months: 3 } };
// @ts-expect-error not a job type
const badType: Job["type"] = "rollback";

const estimate: z.infer<typeof estimateJobSchema> = { templateId: "saas", config: {} };

type Invite = z.infer<typeof inviteSchema>;
const invite: Invite = { email: "a@example.com", role: "admin" };
// @ts-expect-error not a team role
const badRole: Invite["role"] = "owner";

const tokens = [
  acceptInviteSchema.parse({ token: "t" }).token,
  switchTeamSchema.parse({ teamId: "0b1d9a5e-4c7f-4e2a-9d3b-6f8a1c2e5b70" }).teamId,
  refreshSchema.parse({ refreshToken: "r" }).refreshToken,
  oauthExchangeSchema.parse({ code: "c" }).code,
  oauthCallbackSchema.parse({ state: "s" }).state
] satisfies string[];

void [job, badType, estimate, invite, badRole, tokens];
