import { z } from "zod";

export declare const refreshSchema: z.ZodObject<{ refreshToken: z.ZodString }>;

export declare const oauthExchangeSchema: z.ZodObject<{ code: z.ZodString }>;

export declare const oauthCallbackSchema: z.ZodObject<{ state: z.ZodString }>;
