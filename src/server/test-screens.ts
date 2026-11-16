// Real agent screens (tmux capture-pane, 60 columns), for tests that need to know what is on an agent's screen.

/** Claude Code 2.1.325 at its prompt (the box holds a greyed-out suggestion, not typed text). */
export const CLAUDE_IDLE = `
                                        ◐ medium · /effort
────────────────────────────────────────────────────────────
❯ Try "how do I log an error?"
────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`;

/** Claude with text typed into its box. */
export const CLAUDE_DRAFT = `
                                        ◐ medium · /effort
────────────────────────────────────────────────────────────
❯ half a thought
────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

/** Claude's /model menu: the input box is gone. */
export const CLAUDE_MENU = `
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model
   Switch between Claude models. Your pick becomes the
   default for new sessions. For other/previous model
   names, specify with --model.

     1.  Default (recommended)  Opus 5.5 · Best for
                                everyday, complex tasks
     2.  Opus 5.5               For complex work and
                                everyday tasks
     3.  Fable 5.2              For your toughest
                                challenges
     4.  Sonnet 5.5             Most efficient for
                                simpler tasks
   ❯ 5.  Haiku 5.5 ✔            Fastest for quick answers
     ▸   More models

   ◐ Medium effort (default) ←/→ to adjust

   Enter to set as default · s to use this session only ·
   Esc to cancel
`;

/** Claude's folder-trust question. */
export const CLAUDE_TRUST = `
 /home/you/some/long/folder/that/wraps/on/a/phone/
 project

 Quick safety check: Is this a project you created or one
 you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to
 review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files
 here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

/** Codex 0.169 at its prompt. */
export const CODEX_IDLE = `
› Ask Codex to do anything

  GPT-6-Luna medium · /home/you/some/long/folder/that/wraps/
  on/a/phone/project
  ← for agents · ? for shortcuts
`;

/** Codex with text typed into its box. */
export const CODEX_DRAFT = `
› half a thought

  GPT-6-Luna medium · /home/you/some/long/folder/that/wraps/
  on/a/phone/project
`;

/** Codex's /model menu. */
export const CODEX_MENU = `
  Select Model and Effort


  1. GPT-6.1-Sol           Latest workhorse model for coding
                           and everyday work.
  2. GPT-6-Astra           Frontier intelligence for the
                           most demanding work.
  3. GPT-6.1 Terra         GPT-6.1 Terra Codex model.
  4. GPT-6-Sol             Previous generation workhorse
                           model.
› 5. GPT-6-Luna (current)  Fast and affordable model for
                           easier tasks.
  6. GPT-5.6-Sol           Older generation workhorse model.
  7. GPT-5.6-Terra         Older balanced model for
                           straightforward work.
  8. GPT-5.6-Luna          Older fast and efficient model.

  enter select · esc back
`;

/** Codex's folder-trust question. */
export const CODEX_TRUST = `
  Folder access
  /home/you/some/long/folder/that/wraps/on/a/phone/
  project

  Trust this folder? Codex can read, edit, and run files
  here, subject to your permission settings. Folder
  settings can run code automatically, even without a
  model request. Continue only if you trust these files.
  Your trust decision will be saved.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back
`;

/** Codex mid-turn: the box is there (a prompt typed now is queued) under its timer. */
export const CODEX_WORKING = `
› Run the shell command: sleep 25


• Running sleep 25 now.


• Working (5s • esc to interrupt) · 1 background terminal r…


› Ask Codex to do anything

  GPT-6-Luna medium · /home/you/some/long/folder/that/wraps/
  on/a/phone/project · Run sleep command
  ← for agents · ? for shortcuts
`;

/** Codex after Esc stopped its turn. */
export const CODEX_INTERRUPTED = `
› Run the shell command: sleep 25


• Running sleep 25 now.

■ Conversation interrupted - use /feedback if something went
wrong



  1 background terminal running · /ps to view · /stop to clo


› Ask Codex to do anything

  GPT-6-Luna medium · /home/you/some/long/folder/that/wraps/
  on/a/phone/project · Run sleep command
  ← for agents · ? for shortcuts
`;

/** Claude mid-turn: its box stays on screen under the spinner. */
export const CLAUDE_WORKING = `
  Reading the file now.

✢ Thundering… (28s · thought for 6s)

────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) ·
`;

// Antigravity CLI (agy) 1.5.9. It has no hooks, so its screen is all ansai has to go on.
/** Antigravity CLI 1.5.9 at its prompt (the box holds a greyed-out hint, not typed text). */
export const AGY_IDLE = `
────────────────────────────────────────────────────────────
> Auto mode: edits & safe commands auto-approved (shift+...
────────────────────────────────────────────────────────────
? for shortcuts               auto · Gemini 3.8 Flash · high
`;

/** Antigravity with text typed into its box: the footer loses its "? for shortcuts". */
export const AGY_DRAFT = `
────────────────────────────────────────────────────────────
> Run the shell command: sleep 12
────────────────────────────────────────────────────────────
                              auto · Gemini 3.8 Flash · high
`;

/** Antigravity mid-turn: the box stays on screen, and the footer says "esc to cancel". Its spinner can sit still for many seconds. */
export const AGY_WORKING = `
─────────────────────────────────────────────────────────
> Run the shell command: sleep 12
⣾  Generating...
────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────
esc to cancel                 auto · Gemini 3.8 Flash · high
`;

/** The same on a 38-column (phone) screen: the footer keeps only "esc to cancel". */
export const AGY_WORKING_NARROW = `
───────────────────────────────────
> Run the shell command: sleep 12
⢿  Generating...
──────────────────────────────────────
>
──────────────────────────────────────
esc to cancel
`;

/** Antigravity after its turn ended (100 columns). */
export const AGY_DONE = `

● Ran (sleep 4) (ctrl+o to expand)

  5

────────────────────────────────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────────────────────────────────
? for shortcuts                                                       auto · Gemini 3.8 Flash · high
`;

/** Antigravity asking to run a command: the box is gone (the "> ..." under the upper rule is your old prompt), the footer still says "esc to cancel". */
export const AGY_ASK = `

─────────────────────────────────────────────────────────
> Run the shell command: touch probe2.txt

● Ran (touch probe2.txt) (ctrl+o to expand)

Command
────────────────────────────────────────────────────────────

Requesting permission for:
   touch probe2.txt

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands
that start with 'touch'
  3. Yes, and always allow for commands that start with
'touch' (Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
esc to cancel                        Gemini 3.8 Flash · high
`;

/** Antigravity after Esc stopped its turn (here: the approval was refused). */
export const AGY_INTERRUPTED = `

─────────────────────────────────────────────────────────
> Run the shell command: touch probe2.txt

● Ran (touch probe2.txt) (ctrl+o to expand)

  ⎿  Interrupted · What should Antigravity CLI do instead?
────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────
? for shortcuts                      Gemini 3.8 Flash · high
`;

/** Idle on a 38-column screen, after an interrupted turn. */
export const AGY_IDLE_NARROW = `

● Ran (touch...) (ctrl+o to expand)

  ⎿  Interrupted · What should Antigra
──────────────────────────────────────
>
──────────────────────────────────────
? for shortcuts
`;
