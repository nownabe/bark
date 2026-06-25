import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppV2Mount } from "./AppV2Mount";
import "./styles.css";

// V2 review surface is opt-in via `?v=2` on the review URL.
// All other URLs land on the legacy App until phase 6i removes it.
function pickEntry() {
  const params = new URLSearchParams(window.location.search);
  return params.get("v") === "2" ? <AppV2Mount /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pickEntry()}</React.StrictMode>,
);
