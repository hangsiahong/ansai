import { useEffect, useRef } from "preact/hooks";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "./api";

import { isTouch } from "./ui";
export { isTouch };

export type TermHandle = {
  send: (data: string) => void;
  focus: () => void;
  setKeyboard: (on: boolean) => void;
  bumpFont: (delta: number) => void;
  armCtrl: (on: boolean) => void;
};

export type TermStatus = "connecting" | "live" | "reconnecting" | "detached";

const THEME = {
  background: "#0a0c0f",
  foreground: "#d9dee7",
  cursor: "#7ee0b0",
  cursorAccent: "#0a0c0f",
  selectionBackground: "#2b3a4a",
  black: "#1b1f27",
  red: "#f07178",
  green: "#9ad27e",
  yellow: "#f2c66d",
  blue: "#7aa7ff",
  magenta: "#c79bff",
  cyan: "#6fd3d6",
  white: "#c8ced8",
  brightBlack: "#5b6270",
  brightRed: "#ff8a91",
  brightGreen: "#b4e59b",
  brightYellow: "#ffd98a",
  brightBlue: "#9cbcff",
  brightMagenta: "#dab8ff",
  brightCyan: "#92e6e8",
  brightWhite: "#f2f4f8",
};

const FONT_KEY = "ansai.fontSize";
function loadFont(): number {
  try {
    const v = Number(localStorage.getItem(FONT_KEY));
    if (v >= 8 && v <= 28) return v;
  } catch {}
  return isTouch() ? 12 : 13.5;
}

export function TerminalView(props: {
  sessionId: string;
  handle: { current: TermHandle | null };
  onStatus?: (s: TermStatus) => void;
  onCtrlUsed?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current!;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "JetBrainsMono Nerd Font", ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", monospace',
      fontSize: loadFont(),
      lineHeight: 1.12,
      cursorBlink: true,
      scrollback: 2000,
      theme: THEME,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener")));
    term.open(el);
    const ta = term.textarea;
    if (ta && isTouch()) {
      ta.setAttribute("inputmode", "none");
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("autocorrect", "off");
    }

    let ws: WebSocket | null = null;
    let disposed = false;
    let detached = false;
    let retry = 400;
    let ctrlArmed = false;

    const status = (s: TermStatus) => props.onStatus?.(s);
    const sendRaw = (m: object) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    const send = (data: string) => sendRaw({ i: data });

    const safeFit = () => {
      if (!el.offsetWidth || !el.offsetHeight) return;
      try {
        fit.fit();
      } catch {}
    };

    const connect = () => {
      if (disposed) return;
      safeFit();
      status(retry > 400 ? "reconnecting" : "connecting");
      const sock = new WebSocket(wsUrl(`/ws/term/${props.sessionId}?cols=${term.cols}&rows=${term.rows}`));
      sock.binaryType = "arraybuffer";
      ws = sock;
      sock.onopen = () => {
        retry = 400;
        term.reset();
        status("live");
        sendRaw({ r: [term.cols, term.rows] });
        sendRaw({ v: document.visibilityState === "visible" }); // no push while you're watching
      };
      sock.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const m = JSON.parse(ev.data);
            if (m.t === "detached") detached = true;
          } catch {}
          return;
        }
        term.write(new Uint8Array(ev.data));
      };
      sock.onclose = () => {
        if (ws !== sock || disposed) return;
        if (detached) {
          status("detached");
          return;
        }
        status("reconnecting");
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };

    term.onData((d) => {
      if (ctrlArmed && d.length === 1) {
        const c = d.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);
        else if (d === " " || d === "@") d = "\x00";
        else if (d === "[") d = "\x1b";
        ctrlArmed = false;
        props.onCtrlUsed?.();
      }
      send(d);
    });
    term.onBinary((d) => send(d));
    term.onResize(({ cols, rows }) => sendRaw({ r: [cols, rows] }));

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(safeFit);
    });
    ro.observe(el);

    // Touch swipe → mouse-wheel events, so tmux scrolls its history (copy mode).
    let lastY: number | null = null;
    let acc = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        lastY = e.touches[0]!.clientY;
        acc = 0;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (lastY === null || e.touches.length !== 1) return;
      const y = e.touches[0]!.clientY;
      acc += y - lastY;
      lastY = y;
      const step = Math.max(12, term.options.fontSize! * 1.4);
      while (Math.abs(acc) >= step) {
        const up = acc > 0; // finger moves down → look at older output
        acc += up ? -step : step;
        if (term.modes.mouseTrackingMode !== "none") send(up ? "\x1b[<64;2;2M" : "\x1b[<65;2;2M");
        else term.scrollLines(up ? -1 : 1);
      }
      e.preventDefault();
    };
    const onTouchEnd = () => (lastY = null);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);

    const onVisible = () => {
      sendRaw({ v: document.visibilityState === "visible" });
      if (document.visibilityState === "visible" && ws && ws.readyState !== WebSocket.OPEN && !detached) {
        retry = 400;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    props.handle.current = {
      send,
      focus: () => term.focus(),
      setKeyboard: (on) => {
        if (!ta) return;
        ta.setAttribute("inputmode", on ? "text" : "none");
        if (on) {
          ta.blur();
          setTimeout(() => term.focus(), 30);
        } else ta.blur();
      },
      bumpFont: (delta) => {
        const size = Math.min(28, Math.max(8, (term.options.fontSize ?? 13) + delta));
        term.options.fontSize = size;
        try {
          localStorage.setItem(FONT_KEY, String(size));
        } catch {}
        safeFit();
      },
      armCtrl: (on) => (ctrlArmed = on),
    };

    connect();
    if (!isTouch()) term.focus();

    return () => {
      disposed = true;
      props.handle.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [props.sessionId]);

  return <div class="term" ref={box} />;
}
