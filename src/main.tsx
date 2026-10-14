import React from "react";
import { createRoot } from "react-dom/client";
import { App, RecordingBar, RegionPicker } from "./App";
import "./style.css";
const route = location.hash;
if (route.startsWith("#region"))
  document.documentElement.classList.add("region-mode");
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {route.startsWith("#region") ? (
      <RegionPicker />
    ) : route === "#recording" ? (
      <RecordingBar />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
