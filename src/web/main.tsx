import { render } from "preact";
import { useEffect } from "preact/hooks";
import "./styles.css";
import { boot, openPalette, useStore } from "./store";
import { DialogHost, Icon, nav, useIsPhone, useRoute } from "./ui";
import { Sheets } from "./sheets";
import { Palette } from "./palette";
import { Sidebar, TabBar } from "./views/nav";
import { NowPane } from "./views/now";
import { ProjectPane } from "./views/project";
import { ProjectsPane } from "./views/projects";
import { SessionPane } from "./views/session";
import { BacklogPane } from "./views/backlog";
import { AccountsPane } from "./accounts";

function Blocked({ reason }: { reason: string }) {
  return (
    <div class="blocked">
      <div class="blocked-card">
        <div class="empty-icon big">
          <Icon name="lock" size={24} />
        </div>
        <h1>This device isn't allowed</h1>
        <p>{reason}</p>
        <p class="muted small">On the laptop, open ansai → Settings → Devices and switch this device on.</p>
        <button class="btn" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    </div>
  );
}

function App() {
  const route = useRoute();
  const phone = useIsPhone();
  const toastS = useStore((s) => s.toast);
  const blocked = useStore((s) => s.blocked);
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

  // ⌘K / Ctrl+K anywhere (the terminal gets every other key).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        openPalette();
      }
    };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
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

  if (blocked) return <Blocked reason={blocked} />;

  let main;
  if (route.startsWith("/s/")) main = <SessionPane id={route.slice(3)} />;
  else if (route.startsWith("/p/")) main = <ProjectPane id={route.slice(3)} />;
  else if (route === "/projects") main = <ProjectsPane />;
  else if (route === "/backlog") main = <BacklogPane />;
  else if (route === "/accounts") main = <AccountsPane />;
  else main = <NowPane />;

  const inSession = route.startsWith("/s/");
  return (
    <div class={`app ${inSession ? "in-session" : ""}`}>
      {!phone && <Sidebar route={route} />}
      <main class="main" key={route}>
        {main}
      </main>
      {phone && !inSession && <TabBar route={route} />}
      <Sheets />
      <Palette />
      <DialogHost />
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
