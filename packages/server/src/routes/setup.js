import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { validate } from "../middleware/validate.js";
import { getQboCredentials, saveQboCredentials } from "../services/app-settings.js";

const keySchema = (label) =>
  z
    .string({ error: `Enter the ${label}.` })
    .trim()
    .min(1, `Enter the ${label}.`)
    .max(200, `The ${label} is at most 200 characters.`);
const qboKeysSchema = z.object({
  clientId: keySchema("Client ID"),
  clientSecret: keySchema("Client Secret")
});

/**
 * Local mode only (mounted at /api/v1/setup): the first-run setup page saves the Intuit developer
 * app keys here. Local guards protect it like every other route; the secret is never returned.
 */
export function setupRoutes() {
  const router = Router();

  router.get(
    "/",
    validate(async (_req, res) => {
      res.json({
        qboConfigured: Boolean(await getQboCredentials()),
        redirectUri: config.qbo.redirectUri
      });
    })
  );

  router.put(
    "/qbo",
    validate(async (req, res) => {
      const keys = qboKeysSchema.parse(req.body);
      await saveQboCredentials(keys);
      res.json({ qboConfigured: true });
    })
  );

  return router;
}
