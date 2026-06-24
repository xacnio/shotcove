import { createRoot } from "react-dom/client";
import "../styles.css";
import App from "./App.jsx";

// StrictMode omitted: double-mount would needlessly reconstruct the imperative canvas controller.
createRoot(document.getElementById("root")).render(<App />);
