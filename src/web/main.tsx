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

  // Keep the app in the part of the screen you can see. iOS doesn't shrink the page
  // for the on-screen keyboard: it pans the view down to the focused field instead.
  // Sizing the app to the visible height alone left that pan in place, so the compose
  // box ended up at the top of the screen with an empty gap down to the keyboard. So
  // size the app to the visible area and move it to wherever that area is.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const f = () => {
      const zoomed = Math.abs(vv.scale - 1) > 0.01; // a pinch-zoom pans on purpose; don't follow it
      root.style.setProperty("--app-h", `${zoomed ? window.innerHeight : vv.height}px`);
      root.style.setProperty("--app-top", `${zoomed ? 0 : Math.max(0, vv.pageTop)}px`);
      const kb = !zoomed && window.innerHeight - vv.height > 120;
      if (!kb && root.hasAttribute("data-kb") && window.scrollY) window.scrollTo(0, 0); // iOS can leave the page scrolled after the keyboard closes
      root.toggleAttribute("data-kb", kb);
    };
    f();
    vv.addEventListener("resize", f);
    vv.addEventListener("scroll", f);
    return () => {
      vv.removeEventListener("resize", f);
      vv.removeEventListener("scroll", f);
    };
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
      <main class="main route-main" key={route}>
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
