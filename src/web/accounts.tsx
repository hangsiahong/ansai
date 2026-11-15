import { useState } from "preact/hooks";
import { api, type Account, type ToolId, type UsageLimit } from "./api";
import { confirmDialog, openSheet, promptDialog, setState, toast, toastError, useStore } from "./store";
import { AGENTS, Icon, TOOL_LABEL, ToolBadge, ago, compact, goBack, nav, until, useTick } from "./ui";

const level = (pct: number) => (pct >= 90 ? "hot" : pct >= 70 ? "warm" : "ok");

function LimitBar({ l }: { l: UsageLimit }) {
  return (
    <div class="limit">
      <span class="limit-label">{l.label}</span>
      <div class={`bar ${level(l.used_percent)}`} role="meter" aria-valuenow={l.used_percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${l.label} used`}>
        <i style={{ width: `${Math.min(100, l.used_percent)}%` }} />
      </div>
      <span class="limit-pct">{l.used_percent}%</span>
      <span class="limit-reset">{l.reset ? "reset since" : l.resets_at ? `resets in ${until(l.resets_at)}` : ""}</span>
    </div>
  );
}

function Spark({ daily }: { daily: number[] }) {
  const max = Math.max(1, ...daily);
  const days = ["", "", "", "", "", "", "today"];
  return (
    <div class="spark" title="Tokens per day, last 7 days">
      {daily.map((n, i) => (
        <i style={{ height: `${Math.max(6, (n / max) * 100)}%` }} class={n ? "" : "zero"} title={`${days[i] || `${6 - i}d ago`}: ${compact(n)}`} />
      ))}
    </div>
  );
}

/** One-line summary used inside pickers. */
function limitSummary(a: Account) {
  const ls = a.usage?.limits ?? [];
  if (!ls.length) return a.plan ?? "";
  return [a.plan, ...ls.slice(0, 2).map((l) => `${l.label.replace("Weekly", "wk").replace("5-hour", "5h")} ${l.used_percent}%`)].filter(Boolean).join(" · ");
}

function AccountCard({ a }: { a: Account }) {
  const [menu, setMenu] = useState(false);
  const t = a.usage?.tokens;
  const hot = a.usage?.limits.some((l) => l.used_percent >= 90);

  const startSession = () => openSheet({ kind: "new", tool: a.tool, accountId: a.id });
  const signIn = async () => {
    try {
      const s = await api.loginAccount(a.id);
      nav(`/s/${s.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  const act = async (what: "prefer" | "rename" | "delete") => {
    setMenu(false);
    try {
      if (what === "prefer") {
        await api.updateAccount(a.id, { preferred: true });
        toast(`${a.name} is now used for new ${TOOL_LABEL[a.tool]} sessions`);
      }
      if (what === "rename") {
        const name = await promptDialog({ title: "Rename account", value: a.name });
        if (name) await api.updateAccount(a.id, { name });
      }
      if (what === "delete") {
        const ok = await confirmDialog({
          title: `Remove ${a.name}?`,
          body: "Its login and history on this laptop are deleted. Your other accounts aren't affected.",
          confirm: "Remove account",
          danger: true,
        });
        if (!ok) return;
        await api.deleteAccount(a.id);
      }
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <article class={`acct ${hot ? "hot" : ""}`}>
      <header class="acct-head">
        <div class="acct-id">
          <div class="acct-name">
            {a.name}
            {a.is_default ? <span class="tag pref" title="Used for new sessions">preferred</span> : null}
          </div>
          <div class="acct-sub">
            {a.email ?? (a.logged_in ? "signed in" : "not signed in")}
            {a.running > 0 && <> · {a.running} running</>}
          </div>
        </div>
        {a.plan && <span class="plan">{a.plan}</span>}
        <div class="menu-wrap">
          <button class="icon-btn" onClick={() => setMenu(!menu)} aria-label="Account actions">
            <Icon name="more" />
          </button>
          {menu && (
            <>
            <div class="menu-scrim" onClick={() => setMenu(false)} />
            <div class="menu">
              {!a.is_default && <button onClick={() => act("prefer")}>Use for new sessions</button>}
              <button onClick={() => (setMenu(false), signIn())}>{a.logged_in ? "Sign in again" : "Sign in"}</button>
              {a.dir && <button onClick={() => act("rename")}>Rename</button>}
              {a.dir && (
                <button class="danger" onClick={() => act("delete")}>
                  Remove account
                </button>
              )}
            </div>
            </>
          )}
        </div>
      </header>

      {a.usage && a.usage.limits.length > 0 && (
        <div class="limits">
          {a.usage.limits.map((l) => (
            <LimitBar l={l} />
          ))}
        </div>
      )}

      {t && (t.week > 0 || (a.logged_in && a.tool !== "agy")) && (
        <div class="tokens">
          <div class="tok">
            <b>{compact(t.five_hour)}</b>
            <span>5 hours</span>
          </div>
          <div class="tok">
            <b>{compact(t.today)}</b>
            <span>today</span>
          </div>
          <div class="tok">
            <b>{compact(t.week)}</b>
            <span>7 days</span>
          </div>
          <Spark daily={t.daily} />
        </div>
      )}
      {t && t.cache_read_week > 0 && (
        <p class="acct-note">
          Fresh tokens: input, cache writes and output. Re-reading cached context added {compact(t.cache_read_week)} more this week (
          {Math.round((t.cache_read_week / Math.max(1, t.total_week)) * 100)}% of all tokens), billed at a small fraction of the price.
        </p>
      )}

      {(a.usage?.note || a.usage?.limits_at) && (
        <p class="acct-note">
          {a.usage?.limits_at ? `Limits as of ${ago(a.usage.limits_at)} ago. ` : ""}
          {a.usage?.note}
        </p>
      )}

      <div class="acct-actions">
        {a.logged_in ? (
          <button class="btn sm" onClick={startSession}>
            <Icon name="play" size={14} /> Start session
          </button>
        ) : (
          <button class="btn sm primary" onClick={signIn}>
            Sign in
          </button>
        )}
        {!a.is_default && a.logged_in && (
          <button class="btn sm ghost" onClick={() => act("prefer")}>
            Use by default
          </button>
        )}
      </div>
    </article>
  );
}

function AddAccount({ tool }: { tool: ToolId }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const a = await api.createAccount(tool, name.trim());
      const s = await api.loginAccount(a.id);
      toast(`Finish signing in to ${a.name} in the terminal`);
      nav(`/s/${s.id}`);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button class="btn sm ghost" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> Add account
      </button>
    );
  return (
    <form
      class="add-acct"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <input autoFocus placeholder="Name, e.g. Work or Personal 2" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      <button class="btn sm primary" disabled={busy || !name.trim()}>
        {busy ? "Creating…" : "Create & sign in"}
      </button>
      <button type="button" class="btn sm ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

export function AccountsPane() {
  useTick(15000);
  const accounts = useStore((s) => s.accounts);
  const tools = useStore((s) => s.tools);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      setState({ accounts: await api.refreshAccounts() });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="pane">
      <header class="topbar">
        <button class="icon-btn phone-only" onClick={() => goBack()} aria-label="Back">
          <Icon name="back" />
        </button>
        <div class="topbar-title">
          <h1>Accounts &amp; usage</h1>
          <div class="sub">Logins, plans and limits</div>
        </div>
        <button class="icon-btn" onClick={refresh} disabled={busy} title="Rescan usage now" aria-label="Rescan usage">
          <Icon name="refresh" />
        </button>
      </header>
      <div class="scroll wide">
        {AGENTS.filter((t) => tools.find((x) => x.id === t)?.installed !== false).map((tool) => {
          const list = accounts.filter((a) => a.tool === tool);
          return (
            <section class="sec acct-section">
              <div class="acct-section-head">
                <h2 class="sec-title with-badge">
                  <ToolBadge tool={tool} size={22} /> {TOOL_LABEL[tool]}
                </h2>
                <AddAccount tool={tool} />
              </div>
              <div class="acct-grid">
                {list.map((a) => (
                  <AccountCard a={a} />
                ))}
              </div>
            </section>
          );
        })}
        <p class="muted small fineprint">
          Token counts come from each tool's local logs (Claude transcripts, Codex rollouts) and include cache reads. Limits are the
          last values the CLI itself fetched. Login tokens never leave this laptop and are never shown here.
        </p>
      </div>
    </div>
  );
}

/** Account chooser in the new-session and task sheets. `null` means "the preferred account". */
export function AccountPicker(p: { tool: ToolId; value: string | null; onChange: (v: string | null) => void }) {
  const accounts = useStore((s) => s.accounts.filter((a) => a.tool === p.tool));
  if (p.tool === "shell" || accounts.length === 0) return null;
  const preferred = accounts.find((a) => a.is_default) ?? accounts[0]!;
  const selected = p.value ?? preferred.id;
  if (accounts.length === 1) {
    return (
      <div class="acct-line">
        <span class="muted">Account</span> {preferred.name}
        {limitSummary(preferred) && <span class="muted"> · {limitSummary(preferred)}</span>}
      </div>
    );
  }
  return (
    <div class="field">
      <span>Account</span>
      <div class="acct-pick" role="radiogroup" aria-label="Account">
        {accounts.map((a) => {
          const hot = a.usage?.limits.some((l) => l.used_percent >= 90);
          return (
            <button
              type="button"
              role="radio"
              aria-checked={selected === a.id}
              class={`acct-opt ${selected === a.id ? "on" : ""} ${hot ? "hot" : ""}`}
              onClick={() => p.onChange(a.id === preferred.id ? null : a.id)}
            >
              <span class="acct-opt-name">
                {a.name}
                {!a.logged_in && <em> · not signed in</em>}
              </span>
              <span class="acct-opt-sub">{limitSummary(a) || a.email || ""}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
