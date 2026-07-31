import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import App from "./App.tsx";
import "./index.css";

// --- Global runtime error surfacing -----------------------------------------
// Anything that escapes React's render tree (async handlers, fetch failures,
// module load errors, unhandled promises) bubbles up here. We turn them into
// toast notifications so the user always sees *something* explaining what
// broke, instead of a silent failure or a blank screen.

const friendlyMessage = (raw: string | undefined): { title: string; description: string } => {
  const msg = raw ?? "Unknown error";
  if (/Failed to fetch dynamically imported module/i.test(msg)) {
    return {
      title: "Couldn't load part of the app",
      description: "A page module failed to load — usually a stale build. Reload the page to fix it.",
    };
  }
  if (/NetworkError|Failed to fetch/i.test(msg)) {
    return {
      title: "Network error",
      description: "We couldn't reach the server. Check your connection and try again.",
    };
  }
  if (/ChunkLoadError|Loading chunk \d+ failed/i.test(msg)) {
    return {
      title: "App update available",
      description: "A new version was deployed. Reload to pick it up.",
    };
  }
  return { title: "Something went wrong", description: msg.slice(0, 240) };
};

window.addEventListener("error", (event) => {
  const { title, description } = friendlyMessage(event.message);
  toast.error(title, { description });
  console.error("[window.onerror]", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const msg = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : JSON.stringify(reason);
  const { title, description } = friendlyMessage(msg);
  toast.error(title, { description });
  console.error("[unhandledrejection]", reason);
});

createRoot(document.getElementById("root")!).render(<App />);
