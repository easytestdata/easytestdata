import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate } from "react-router-dom";

export function useAdminHotkeys() {
  const navigate = useNavigate();

  // G then U → Users
  useHotkeys("g u", () => navigate("/admin/users"), { preventDefault: true });

  // G then J → Jobs
  useHotkeys("g j", () => navigate("/admin/jobs"), { preventDefault: true });

  // G then D → Dashboard
  useHotkeys("g d", () => navigate("/admin"), { preventDefault: true });

  // G then C → Connections
  useHotkeys("g c", () => navigate("/admin/connections"), { preventDefault: true });
}
