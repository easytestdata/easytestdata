/** Admin area gate: the single `users.is_admin` flag (loaded by authenticate). */
export function requireAdmin(req, res, next) {
  if (req.user?.isAdmin === true) return next();
  return res.status(403).json({ error: "Insufficient permissions" });
}
