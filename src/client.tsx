import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/globals.css";
import DiscoverRepositories from "./app/discover/page";
import Home from "./app/page";
import SettingsPage from "./app/settings/page";

const page = window.location.pathname === "/discover"
  ? <DiscoverRepositories />
  : window.location.pathname === "/settings"
    ? <SettingsPage />
    : <Home />;

document.title = window.location.pathname === "/discover"
  ? "Discover repositories — Codewiki"
  : window.location.pathname === "/settings"
    ? "AI settings — Codewiki"
    : "Codewiki — repository knowledge, kept current";

const root = document.getElementById("root");
if (!root) throw new Error("Codewiki root element is missing.");
createRoot(root).render(<StrictMode>{page}</StrictMode>);
