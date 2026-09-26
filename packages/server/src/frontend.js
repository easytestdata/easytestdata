import express from "express";
import { join } from "node:path";
import { normalizeRoutePath } from "./http/route-path.js";

/**
 * Serves the web SPA. The marketing site is hosted separately (MARKETING_URL), so in both modes
 * "/" and every other non-API path fall back to the SPA, whose React Router handles app routes.
 */
export function mountFrontend(app, { webDistDir }) {
  // React SPA bundles (content-hashed, safe to cache forever)
  app.use("/assets", express.static(join(webDistDir, "assets"), { maxAge: "1y", immutable: true }));
  // Other files in web/dist (favicon.svg, ...)
  app.use(express.static(webDistDir, { index: false, redirect: false }));

  // SPA fallback: React Router handles the app's routes.
  app.get("/{*path}", (req, res, next) => {
    // Express routes case-insensitively, so /API/... is an API path too (unknown ones get 404).
    const path = normalizeRoutePath(req.path);
    if (path === "/api" || path.startsWith("/api/")) return next();
    res.sendFile(join(webDistDir, "index.html"));
  });
}
