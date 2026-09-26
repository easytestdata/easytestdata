import { z } from "zod";

export const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

export const oauthExchangeSchema = z.object({
  code: z.string().min(1)
});

export const oauthCallbackSchema = z.object({
  state: z.string().min(1)
});
