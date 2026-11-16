import { Component, type ComponentChildren } from "preact";
import { openSheet } from "./store";
import { Icon } from "./ui";

/**
 * What stands between one broken screen and a blank app. A render that throws used to
 * take the whole page down with it: on the phone that is an empty screen with nothing to
 * tap. Now the part that broke shows what went wrong and how to get out, and the rest of
 * the app (the tab bar, the sidebar) keeps working.
 */

/** The error as a few short lines: its message, then where it came from. */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e ?? "Unknown error").slice(0, 600);
  const head = `${e.name}: ${e.message}`;
  const frames = (e.stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !head.includes(l) && l !== head)
    // Bundled file URLs are long and all alike; the function names are what help.
    .map((l) => l.replace(/\(?https?:\/\/[^\s)]*\/([^/\s)]+)\)?/, "($1)"))
    .slice(0, 4);
  return [head, ...frames].join("\n").slice(0, 600);
}

let reported = 0;
/** Tell the laptop, so the error is in ansai's log and not only on a phone screen. */
export function reportError(e: unknown, where: string) {
  if (reported++ >= 5) return; // a render loop would repeat the same one
  try {
    fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ where, route: location.pathname, text: errorText(e) }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

type Props = {
  /** app: the whole page. page: the pane of one route. sheet: the open sheet. */
  where: "app" | "page" | "sheet";
  children?: ComponentChildren;
};

export class ErrorBoundary extends Component<Props, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error("Unknown error") };
  }

  componentDidCatch(error: unknown) {
    console.error(`[ansai] the ${this.props.where} failed to draw:`, error);
    reportError(error, this.props.where);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { where } = this.props;
    const retry = () => this.setState({ error: null });
    const card = (
      <div class="blocked-card crash-card" role="alert">
        <div class="empty-icon big">
          <Icon name="alert" size={24} />
        </div>
        <h1>{where === "sheet" ? "This sheet couldn't be shown" : where === "page" ? "This page couldn't be shown" : "ansai hit an error"}</h1>
        <p>Your agents are not affected: they keep running on the laptop.</p>
        <pre class="crash-text">{errorText(error)}</pre>
        <div class="crash-actions">
          {where === "sheet" ? (
            <button class="btn" onClick={() => (openSheet(null), retry())}>
              Close
            </button>
          ) : (
            <button class="btn" onClick={retry}>
              Try again
            </button>
          )}
          <button class="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
          {where === "app" && location.pathname !== "/" && (
            <button class="btn" onClick={() => location.assign("/")}>
              Go to Now
            </button>
          )}
        </div>
      </div>
    );
    if (where === "sheet") return <div class="crash-over">{card}</div>;
    return <div class={where === "app" ? "blocked" : "crash-page"}>{card}</div>;
  }
}

/**
 * Before anything is drawn (the script failed to start), there is no component to show an
 * error: write a plain screen into the page instead. After that, errors outside rendering
 * (a tap handler, a timer) leave the page as it is; they are only reported.
 */
export function watchForErrors(root: HTMLElement) {
  const fail = (e: unknown) => {
    reportError(e, "window");
    if (root.childElementCount) return;
    const box = document.createElement("div");
    box.className = "blocked";
    const card = document.createElement("div");
    card.className = "blocked-card crash-card";
    card.setAttribute("role", "alert");
    const h = document.createElement("h1");
    h.textContent = "ansai couldn't start";
    const pre = document.createElement("pre");
    pre.className = "crash-text";
    pre.textContent = errorText(e);
    const b = document.createElement("button");
    b.className = "btn primary";
    b.textContent = "Reload";
    b.onclick = () => location.reload();
    card.append(h, pre, b);
    box.append(card);
    root.append(box);
  };
  window.addEventListener("error", (e: ErrorEvent) => {
    // Chrome's harmless note about resize callbacks; not a failure.
    if (/ResizeObserver loop/.test(e.message ?? "")) return;
    fail(e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    if ((e.reason as { name?: string } | null)?.name === "AbortError") return;
    fail(e.reason);
  });
}
