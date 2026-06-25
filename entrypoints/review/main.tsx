import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppV2Mount } from "./AppV2Mount";
import "./styles.css";

// V2 is the default review surface. The legacy App is still reachable via
// `?v=1` on the URL until phase 6j removes it.
function pickEntry() {
  const params = new URLSearchParams(window.location.search);
  return params.get("v") === "1" ? <App /> : <AppV2Mount />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pickEntry()}</React.StrictMode>,
);
