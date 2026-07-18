import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./theme.css";
import "./app.css";

performance.mark("dash:module-ready");

const root = document.getElementById("root");
if (!root) {
  throw new Error("Dash root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
