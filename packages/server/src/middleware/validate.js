import { z } from "zod";

/**
 * Wraps an async route handler to catch ZodErrors and forward other errors to next().
 * Eliminates the repeated try/catch + ZodError pattern across all routes.
 *
 * Usage:
 *   router.post("/", validate(async (req, res) => {
 *     const data = someSchema.parse(req.body);
 *     // ... handler logic ...
 *   }));
 */
export function validate(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues[0].message });
      }
      next(err);
    }
  };
}
