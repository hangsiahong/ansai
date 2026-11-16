import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { toast, toastError } from "./store";
import { Icon } from "./ui";

const KINDS = [
  { id: "input", label: "An agent needs you", hint: "permission prompts and questions", icon: "question", color: "orange" },
  { id: "done", label: "An agent finished its turn", hint: "Claude Code and Codex", icon: "check", color: "green" },
  { id: "exited", label: "An agent crashed", hint: "exited with an error", icon: "stop", color: "red" },
  { id: "system", label: "The machine is struggling", hint: "disk almost full, overheating, low memory or battery", icon: "cpu", color: "red" },
] as const;

function b64ToBytes(b64: string) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function NotifyPanel() {
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({ input: true, done: true, exited: true, system: true });
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(supported() ? Notification.permission : "unsupported");

  useEffect(() => {
    if (!supported() || !isSecureContext) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then(async (s) => {
        setSub(s);
        if (s) {
          const r = await api.pushStatus(s.endpoint);
          if (r.prefs) setPrefs({ input: true, done: true, exited: true, system: true, ...r.prefs });
          else setSub(null); // server forgot it; let the user re-enable
        }
      })
      .catch(() => {});
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPerm(result);
      if (result !== "granted") throw new Error("Notifications are blocked for this site in your browser settings.");
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.pushKey();
      const s = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
      await api.pushSubscribe(s.toJSON(), prefs);
      setSub(s);
      toast("Notifications on for this device");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!sub) return;
    setBusy(true);
    try {
      await api.pushUnsubscribe(sub.endpoint);
      await sub.unsubscribe();
      setSub(null);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string, on: boolean) => {
    const next = { ...prefs, [id]: on };
    setPrefs(next);
    if (sub) api.pushSubscribe(sub.toJSON(), next).catch(toastError);
  };

  let body;
  if (perm === "unsupported" || !isSecureContext) {
    body = (
      <p class="muted">
        {isIOS() && !standalone()
          ? "On iPhone and iPad, add ansai to your Home Screen first (Share → Add to Home Screen), open it from there, then turn notifications on."
          : "This browser can't receive push notifications here. Open ansai over its https:// Tailscale address."}
      </p>
    );
  } else {
    body = (
      <>
        <div class="notify-state">
          <span class={`notify-icon ${sub ? "on" : ""}`}>
            <Icon name="bell" size={16} />
          </span>
          <div>
            <b>{sub ? "On for this device" : perm === "denied" ? "Blocked in browser settings" : "Off for this device"}</b>
            <div class="muted small">Pushes go out only when you're not already looking at that session.</div>
          </div>
        </div>
        {sub && (
          <div class="panel">
            {KINDS.map((k) => (
              <label class="switch-row in-panel">
                <span class={`tile ${k.color}`}>
                  <Icon name={k.icon} size={16} />
                </span>
                <span class="switch-text">
                  <b>{k.label}</b>
                  <em>{k.hint}</em>
                </span>
                <input type="checkbox" class="switch" checked={prefs[k.id] !== false} onChange={(e) => toggle(k.id, (e.target as HTMLInputElement).checked)} />
              </label>
            ))}
          </div>
        )}
        <div class="row">
          {sub ? (
            <>
              <button class="btn sm" disabled={busy} onClick={() => api.pushTest(sub.endpoint).then(() => toast("Test sent")).catch(toastError)}>
                Send a test
              </button>
              <button class="btn sm ghost" disabled={busy} onClick={disable}>
                Turn off
              </button>
            </>
          ) : (
            <button class="btn primary" disabled={busy || perm === "denied"} onClick={enable}>
              Turn on notifications
            </button>
          )}
        </div>
      </>
    );
  }

  return <div class="notify">{body}</div>;
}
