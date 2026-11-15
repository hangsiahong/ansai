import { render } from "preact";
import { useEffect } from "preact/hooks";
import "./styles.css";
import { boot, useStore } from "./store";
import { nav, useRoute } from "./ui";
import { Sheets } from "./sheets";
import { Home } from "./views/home";
import { Overview } from "./views/overview";
import { ProjectPane } from "./views/project";
import { SessionPane } from "./views/session";
import { BacklogPane } from "./views/backlog";
import { AccountsPane } from "./accounts";

function App() {
  const route = useRoute();
  const toastS = useStore((s) => s.toast);
  const waiting = useStore((s) => s.sessions.filter((x) => x.status === "running" && x.agent_state === "needs-input").length);

  useEffect(() => {
    document.title = waiting ? `(${waiting}) ansai` : "ansai";
  }, [waiting]);

  // A tapped notification asks an open window to navigate to its session.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const f = (e: MessageEvent) => typeof e.data?.nav === "string" && e.data.nav.startsWith("/") && nav(e.data.nav);
    navigator.serviceWorker.addEventListener("message", f);
    return () => navigator.serviceWorker.removeEventListener("message", f);
  }, []);

  // Keep layout above the on-screen keyboard (iOS doesn't resize the layout viewport).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const f = () => document.documentElement.style.setProperty("--app-h", `${vv.height}px`);
    f();
    vv.addEventListener("resize", f);
    return () => vv.removeEventListener("resize", f);
  }, []);

  let main;
  if (route.startsWith("/s/")) main = <SessionPane id={route.slice(3)} />;
  else if (route.startsWith("/p/")) main = <ProjectPane id={route.slice(3)} />;
  else if (route === "/backlog") main = <BacklogPane />;
  else if (route === "/accounts") main = <AccountsPane />;
  else main = <Overview />;

  return (
    <div class={`app ${route === "/" ? "at-home" : "at-detail"}`}>
      <aside class="side">
        <Home route={route} />
      </aside>
      <main class="main">{main}</main>
      <Sheets />
      {toastS && (
        <div class={`toast ${toastS.kind}`} role="status">
          {toastS.msg}
        </div>
      )}
    </div>
  );
}

// Added at runtime: Bun's HTML bundler would otherwise try to bundle these server-served files.
for (const [rel, href, type] of [
  ["manifest", "/manifest.webmanifest"],
  ["icon", "/icon.svg", "image/svg+xml"],
  ["apple-touch-icon", "/icon-192.png"],
] as const) {
  const l = document.createElement("link");
  l.rel = rel;
  l.href = href;
  if (type) l.type = type;
  document.head.appendChild(l);
}

boot();
render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
