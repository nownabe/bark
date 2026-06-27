import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Legacy App is the live review surface. AppV2 / AppV2Mount are parked on
// disk (not mounted) while we wire the legacy UI on top of the new data
// layer (lib/pr/). They are kept compiled so we can lift bits across.

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
