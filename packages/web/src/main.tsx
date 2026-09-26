import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Inter is bundled with the app: no request to a font service, and it passes the production CSP.
import "@fontsource-variable/inter";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
