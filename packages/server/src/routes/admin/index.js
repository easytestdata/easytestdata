import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireAdmin } from "./middleware.js";
import { dashboardRoutes } from "./dashboard.js";
import { userRoutes } from "./users.js";
import { jobRoutes } from "./jobs.js";
import { connectionRoutes } from "./connections.js";

/** The admin area: Overview, Users, Jobs and Connections, all behind `users.is_admin`. */
export function adminRoutes() {
  const router = Router();
  router.use(authenticate);
  router.use(requireAdmin);

  router.use("/dashboard", dashboardRoutes());
  router.use("/users", userRoutes());
  router.use("/jobs", jobRoutes());
  router.use("/connections", connectionRoutes());

  return router;
}
