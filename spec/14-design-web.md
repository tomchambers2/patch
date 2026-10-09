# Web App Design

Static SPA served by the server at `/app`. Primary at-the-desk surface.

## Visual system

Reference: `design/web-hi-fi.html` (canonical), supporting tokens in `design/hi-fi-tokens.css`. Visual language:

- Paper — warm-paper app background, raised surfaces and the main right/content panel are white (`#ffffff`), and every text field (composer, search, settings inputs, folder picker) is white with a green focus ring so it reads as an editable field against the paper. No grey-blue.
- Accent — leaf green `#4f7a3e` (state running/done, accept buttons, focus rings). Soft variant `#cad9be` for hover backgrounds; tint `#e3ecdb` for selected-row backgrounds; strong `#3a5e2c` for hover-on-accent.
- Waiting / working / call states — burnt-orange `#c46a12` with tint `#ecc99a`. Permission ("waiting on you") — indigo `#574fa6` with tint `#d6d2ef`, the palette's only cool hue (§ Status badges). Voice / urgent — terracotta `#a64a3a`.
- Type — `Fraunces` for display. The brand wordmark is italic (it's the logo); page titles and chat titles are upright (roman) Fraunces — same elegant high-contrast serif without the heavy slant. Inside the transcript, message prose is a single font — markdown headings (`#`/`##`/`###`) render in the body font (heavier + a touch larger), NOT Fraunces, so a reply reads as one type system. A model-emitted `---` renders as quiet breathing room (generous margin, a barely-there hairline), not a hard rule. `Figtree` for body and UI — a warmer, rounder humanist sans than the previous `Inter` (which read blunt for long transcript prose); `Inter` remains the metrics-compatible fallback. `JetBrains Mono` for code, paths, kbd hints, timestamps — used only in fenced code blocks, not for inline code, which stays in the body font (a tinted background marks it as code without a jarring font-family switch mid-sentence). All body/UI/mono faces are self-hosted (CSP blocks external fonts). Variations on Fraunces use `opsz` and `SOFT` axes to soften optically.
- Radii — `6px` small (badges, kbd), `10px` standard (rows, cards), `16px` large (cards, banner), pill `999px` (status pills, tags).
- Shadows — `--shadow-sm` for inline cards, `--shadow` for stages and dropdowns, `--shadow-lg` for popovers and overlays.
- Legibility — base font is 16px (line-height 1.55). Minimum text size is `13px` (`--text-min`) — no UI text, however secondary (metadata, timestamps, status labels, links, kbd hints, badges, monospace chrome), renders smaller than that, on ANY surface: mobile carries the same floor as `textMin` in its theme (`15-design-mobile.md`). It is a floor, not a suggestion, and it is enforced by a test that scans every stylesheet and every screen and fails on a size below it; an exception needs an entry in that test's allow-list AND a comment saying why at the rule itself. There are currently none. A relative size (`0.85em`) counts as below the floor unless it is clamped — `max(0.85em, var(--text-min))` — because what it resolves to depends on a parent it does not control. Secondary-text tokens (`--ink-3`, `--ink-faint`) and the hairlines (`--line`, `--line-soft`) sit at readable contrast (≈5:1 for `--ink-3`) while staying warm-grey — long event streams must stay readable.
- Hit targets — a control is never smaller than `44px` (`--tap-min`) on either axis, however small its text. Text size and target size are separate: a 13px back button is fine, a 50x16px one is not. Where padding would push a control out of alignment with what it sits above, it is pulled back with a negative margin of the same size, so the target grows without the layout moving.
- Controls — a boolean setting is a toggle switch. The switch position is the state; its label is a static noun that names the setting (e.g. "Enabled" stays "Enabled" whether on or off — the switch shows on/off, the word doesn't flip). The accent-green filled track = on. No bare native checkboxes anywhere in the UI. Anything that commits — every Save, Create, Apply, Connect, Add — is a real button and is drawn as one: its own surface, border, radius and padding, a pointer cursor, and the same accent focus ring the fields carry when the keyboard reaches it. A commit control is never left to the browser's own default styling, which the app's reset strips back to plain text. It is dead — visibly dimmed, plain cursor — whenever there is nothing to commit or its own request is still in flight, and its `⌘ ↵` refuses on exactly the same terms (§ Keyboard shortcuts), so the chord can never force a save the control is declining.

### Copy — no helper text

Do not add helper text. A control must be clear from the UX itself — its label, its position, its icon, and the state it shows. Never add a sentence, caption, subtitle, or parenthetical that explains what a button or control does. Prose describing what a control does ("Click this to save your changes", "This toggle enables notifications", "Use the field below to…") is banned everywhere in the UI — it is noise, it dates instantly, and it signals a control that should have been made self-evident instead. If a control needs a paragraph to explain it, redesign the control, don't caption it. This applies across every surface (web, mobile, terminal, menu bar): Settings sections already carry no explanatory prose (§ `/settings` details) and section headers carry no descriptive subtitle (`15-design-mobile.md` § Settings) — the same rule governs every button, icon, field, tab, and row. The controls speak for themselves.

Tool descriptions are the one content exception. The Tools panel's per-tool
sentence is not helper text — it is the dialog's subject matter. The user is
being shown the agent's capabilities, and a tool name alone (`Glob`, `patch_peek`)
does not convey a capability. The carve-out is deliberately narrow and holds only
inside the Tools panel (§ Tools panel):

- It describes what the tool does. "Reads a file
  from disk" is content; "Toggle this off to hide the tool from the agent" is
  banned helper text like anywhere else.
- It is one sentence — present tense, third person, starting with the verb.
  No second sentence and no advice to the user about when to reach for it — a
  trailing em-dash clause naming examples or the tool's shorthand is still part
  of saying what it does, and is fine.
- It attaches only to a tool row. The dialog carries no intro paragraph, no
  per-category blurb, and no caption under the toggle; the only prose in it is
  the per-tool sentences.

Tooltips are the rare exception, not the norm. An icon-only control (no visible text label) may carry a short hover tooltip naming what it does — e.g. the chat-header action icons (§ Chat panel header). Reach for a tooltip only when a glyph genuinely can't be self-explanatory; a control with a visible text label needs none — if it has a shortcut, its tooltip is the chord alone (`⌘N`), never the label repeated with the chord after it. A tooltip is a short name of a few words, in sentence case, never a sentence explaining the control — "Discard draft", not "discard draft" and not "Discard draft — throws away what you typed". A control's accessible label is written the same way; it may name the thing acted on where the tooltip's context makes that redundant ("Archive chat" against a tooltip of "Archive"), but it never disagrees with it in case or wording.

Text clipped to fit its space is the other sanctioned case, and there a tooltip is required rather than merely allowed: wherever a name or path ellipsises it carries its full value as a hover tooltip, so nothing the app has truncated is unrecoverable. That tooltip is a value rather than an explanation, so neither the length nor the sentence-case rule applies to it — it reproduces the text verbatim. It is the ONLY tooltip such an element gets: no row carries an explainer tooltip alongside its own name, Manager included (§ Sidebar). What a thread is belongs in the thread, not in a hover.

A tooltip is the app's own popover, not the browser's built-in title bubble — the built-in one is slow to appear, carries no app styling, and can run off the edge of the window. It appears quickly on hover, and immediately on keyboard focus so a control reached by Tab is named without a pointer. It stays clear of the window edge, flipping to the opposite side of its control rather than clipping. It disappears the moment the pointer or focus leaves the control, or the page scrolls.

An em dash joining two clauses is helper text wearing punctuation. Visible copy says its piece in a plain sentence and stops, or starts a second sentence: `Agent offline. Messages are queued and sent when it reconnects.`, not `Agent offline — messages will be queued…`. The em dash survives only where it is not prose: as the placeholder glyph for a value the app does not have (`—`), as the separator between two values on one line (`kitchen — speaker`), in a placeholder option (`— pick a chat —`), and in the Tools panel's per-tool sentence, which is content (above).

The one sanctioned place for a helper line is an empty state — and only a single plain sentence (`15-design-mobile.md` § Empty states). That is the deliberate exception; it is not licence to sprinkle explanatory copy anywhere else.

### Icons

Icons carry meaning, so they must be consistent — the same action wears the same glyph and the same weight everywhere. Two conventions are load-bearing and easy to get wrong:

- Delete / destructive → a friendly bin. A destructive delete uses the app's bin glyph (`DeleteIcon`). The bin is deliberately fun and friendly — a lidded can with a rounded handle and ribs — not a stark, flat trash can. Wherever the "trash / deleted" concept appears (the chat-header delete action, the sidebar's Deleted group) it is the same bin.
- Close / dismiss → an ×. Closing a panel, clearing a banner, removing a chip or a queued item, forgetting a folder, discarding a draft — all use the shared × glyph (`CloseIcon`).

One shared source, one generous size. Delete/close glyphs come from a single shared icon module. They share one generous, consistent size (≈18px) so a bin and an × read at the same weight and every dismiss/delete control is comfortably large and easy to hit. A tight cluster (e.g. the file-editor toolbar, where the close sits among 20px icons) may pass an explicit matching size, but the default is the shared size. Icon-only delete/close buttons still follow the tooltip rule above (a one- or two-word hover name).

## Layout (desktop)

Two columns: sidebar · pane area, plus the Tools sidebar (§ Tools panel) pinned to the right of the pane area while it is open. The current hi-fi reference is `design/web-hi-fi.html`. The pane area is itself a tree of panes and tabs — see § Panes and tabs. There is no third, permanently-docked editor/terminal column: a file, a diff or a shell is a tab like any other, living inside the same pane tree (§ Panes and tabs) rather than beside it.

All column dividers, including the ones between panes (§ Panes and tabs), are drag-resizable. The user can widen the sidebar, etc. State persists per-user. Defaults: sidebar 280px, main fills remaining width. The sidebar drags between 200px and 600px, and is never drawn wider than that ceiling anywhere in the app: it is a column of names against times, and stretched past it a row's name and its time no longer read as one row. The Tools sidebar's divider is drag-resizable too (320px default and minimum, capped viewport-relative, persisted per-user); double-clicking it restores 320px.

There is no top bar. The brand and its connection dot sit in the sidebar header. A chat tab's header is the app's top bar for that tab: Back / Forward at its far left, and the per-chat controls (`waiting on you` pill, action icons) across it (§ Chat panel header).

A page's own Back control — the job editor's, a settings page's `←` — returns to the page the user was on before it, wherever that was: a job opened from a chat goes back to the chat, a settings page opened from a chat's banner goes back to the chat. It goes to the page's parent (the jobs list, the settings list) only when there is nothing earlier in the window to return to, as for a deep link or a page opened in a new window. Leaving the job editor by saving or deleting follows the same rule.

The shell is exactly the height of the window and the page itself never scrolls, whatever a route holds. Only the regions named here as scrolling scroll, each within the shell, so the window can never be dragged past the end of a route's content onto empty space. This binds anything drawn outside the normal flow too: a control that is visually hidden rather than removed — the real input behind a switch (§ Controls) — stays inside its own control's box, because a hidden element that escapes to the shell instead adds its offset to the page's scrollable height and buys dead scroll below content that has already ended.

The sidebar collapse toggle (§ Sidebar) is a visible chevron, not just the `⌘ /` shortcut: a `‹` button in the sidebar's own brand row collapses it, and while collapsed a small `›` chevron near the shell's top-left is the only sidebar-related control left on screen — it is what restores it (click, or `⌘ /` from anywhere). Because it is the only way back to the sidebar, it is a self-contained square control — bordered and rounded on all four corners — inset from the window edge rather than butted flush against it as a half-tab, and never smaller than a comfortable hit target on either axis.

### Narrow widths

The shell never grows a page-level horizontal scrollbar, at any viewport width down to ~375px. Two breakpoints keep the fixed-width columns from forcing the page wider than the window:

- Below 768px, the sidebar auto-collapses (the same collapsed state the user's own sidebar toggle controls).

This reacts live to the viewport, not just on load. It only acts on the width crossing the breakpoint, not on every resize while the viewport stays on the same side of it — so if the user manually reopens the sidebar while still narrow, a further resize that stays narrow does not immediately re-collapse it; it fires again only on the next crossing. Crossing back above the breakpoint does not force the sidebar back open — only auto-collapsing below is specified, and re-opening stays with the user's own toggle. There is no equivalent rail-width breakpoint: a file/terminal/page tab is sized by its pane, same as a chat tab, not by a standalone rail with its own minimum width to protect.

### Mini sidebar

Dragging the sidebar's divider narrower than the full sidebar can go (below 140px) turns the sidebar into a mini rail: a 52px column showing only each chat's status badge, so the user can move up and down the chats while the rest of the screen is given to something else. It lists the same rows in the same order as the full sidebar — Manager (its compass glyph), Pinned, then each project's chats with a hairline between projects — and the open chat's dot carries the `active` state. A dot's only text is its tooltip, the chat's name (§ Copy); clicking it opens the chat as a sidebar row does. A `›` button at the top of the rail restores the full sidebar, and so does dragging the rail's divider back out to 140px or wider; the full sidebar returns at the width it was last dragged to. The choice persists per-user like the sidebar's width. Collapsing (§ Layout) hides the rail the same as the full sidebar.

Below 768px the sidebar is a drawer rather than a column. Reopened at that width it is drawn over the chat panel, which keeps the full width of the window, and it is capped to most of the window's width so the chat stays visible behind it. A dimmed backdrop covers the chat panel while the drawer is open; tapping it closes the drawer, as does the sidebar's own collapse chevron. The sidebar is not drag-resizable while it is a drawer — its divider is not drawn.

The chat panel header's action icon row (§ Chat panel header) collapses into a single menu button once its own width can't fit every icon cleanly, rather than shrinking the icons or widening the header.

## Panes and tabs

The area right of the sidebar is a tree of panes: side by side or stacked, nested as deep as the user splits it. Each pane holds an ordered list of tabs and shows one of them at a time. A tab is one of four kinds:

- **Chat** — a chat's transcript + composer (what the single-tab case always was).
- **File** — one open file, editor or diff (§ Editor — two surfaces). One tab per file: opening a second file never reuses or overwrites the first's tab, the same "something already open is focused, not duplicated" rule covers re-opening the SAME file.
- **Terminal** — one chat's shell session (§ Terminal).
- **Page** — Jobs, a job's editor, Settings, a chat's Files tree (the file browser's tree-only view, § Editor — two surfaces § File browser), the Pads list, a Pad or New Pad (§ Pads). These are the app's other full-screen surfaces, now ordinary tabs instead of separate routes rendered outside the pane tree.

What used to be docked, separately-toggled surfaces — the editor rail, the terminal drawer — are gone as distinct concepts: opening a file, a terminal or the file tree opens a tab, on exactly the rules below, and closes like any other tab. Desktop and web only — mobile stays the single view it has always been (`15-design-mobile.md`). The built-in web panel (§ Links and the web panel) and artifacts opened in it are a desktop-shell-only, native surface outside this pane/tab tree entirely — they are not a tab kind.

Each pane draws its own tab bar directly above its content, UNLESS the whole tree is a single pane holding a single tab: that is the common case — one chat, nothing to switch between or move — and it draws no bar at all, exactly as if panes and tabs did not exist. The bar appears the moment there is something to manage: a second tab in the same pane, or a second pane anywhere in the tree.

A tab bar reads left to right in the order the user left it, drawn flat on the paper tone with a hairline beneath: each tab a title (with its kind's icon, or a chat's status badge) and a close control, no boxes between them. The active tab is white, like the content it opens onto, with an underline — accent in the focused pane, muted in the others. A tab's title and badge are live: renaming a chat or a job renames its tab. A tab is one control; its close button is a separate button beside the title, never nested inside it. A plain open that replaces the active tab takes that tab's place in the bar, and closing the active tab activates the tab that slides into its place (the one before it when it was last). The active tab is highlighted; the pane holding it is highlighted too when more than one pane is on screen, so a glance says where a keyboard chord or a sidebar click will land. Clicking a tab activates it and focuses its pane. A close control sits on every tab — not hover-revealed, since a touch surface has no hover and the chord/middle-click paths already cover the pointer-free case — and middle-clicking a tab closes it the same way. Closing a pane's last tab closes the pane itself, collapsing the split it sat in; the one exception is the last pane left in the whole tree, which stays, empty, rather than leaving nothing to click into.

### Opening things

Opening something — a sidebar row, a link:

- A plain click opens it in the active pane, replacing that pane's current tab, UNLESS the current tab has unsaved edits, in which case it opens as a new tab instead. Something already open anywhere in the tree is focused rather than opened a second time, overriding both of the above.
- A middle click, or right-click → "Open in new tab", opens it as a new tab in the active pane.
- Right-click also offers "Open to the side", which opens it in a new pane split from the active one, and "Open in new window", which detaches it into its own window via the same mechanism § New windows already uses for a chat.
- On a job's page, a plain click on a run's chat link (Recent runs, or a running fire in the Queue panel) opens that chat in the pane directly to the right of the job rather than navigating away: the first click splits that pane off, later clicks replace the chat in it, and the job page stays in view. ↑/↓ with focus on a run's chat link steps to the previous/next run that has a chat and updates the pane to it. The chat there is the ordinary live chat, so it can be replied to. Middle click is still a new tab in the active pane; a modified click and the browser's own context menu keep the link's new-tab / new-window meaning.

A tab is dragged by its bar. Dropped on the same bar it reorders; dropped on a different pane's tab bar it moves there, at the position dropped; dropped on a different pane's content area it moves there as a new tab; dropped on the edge of any pane's content area (the outer quarter of that pane, on whichever side the pointer is nearest) it splits that pane there, arriving as the tab of a new pane on that side. A pane split on the same axis as the one it is already inside grows that split by one child rather than nesting a new one inside it, so repeated splits in the same direction read as one row or column of panes, not a tree of them.

Every divider between two panes is drag-resizable, on the same convention as the sidebar's own divider (§ Layout — desktop): a thin hit area that widens on hover, dragged to reapportion the space between the panes either side of it.

The whole layout — every pane, its size, its tabs and which one is active — persists per-user across reloads and restarts, the same `localStorage` convention the rest of this layout uses. This is independent of the browser's address bar: a plain navigation (a sidebar click, a link, the browser's own back/forward) still opens its target in the active pane as above, but switching which tab or pane is focused by other means — clicking a different tab, a middle-click open, a drag — does not push the address bar to match. The persisted layout, not the URL, is what a reload or restart is restored from.

### Keyboard

`⌘ W` closes the active pane's active tab. Like `⌘ P` and `⌘ K` elsewhere in this table, it is claimed unconditionally — never ceded to a focused text field, because the OS's own meaning for the chord is closing the real browser tab or window, and that is worse than overriding a field's native keys that nothing here collides with. `⌘ ⌥ ←` / `⌘ ⌥ →` step the active pane's tabs, wrapping at the ends. `⌘ \` splits the active pane, moving its active tab into the new one, even when that pane holds only the one tab — unlike a drag onto a pane's own edge (which treats that case as an accidental gesture and does nothing), an explicit chord asking for a split gets one. All three are scoped to a chat view (§ Discoverability) but, like `⌘ W`, read past a focused text field: opening a chat puts the cursor in the composer by default (§ Composer), and none of the three collides with anything a field's own keys do.

`⌥ E` toggles the active chat's Files tab (§ File browser): open/focus it if it isn't the active tab already, close it if it is — the same toggle the chat header's own Editor icon runs (§ Chat panel header). `` ⌃ ` `` toggles the active chat's Terminal tab (§ Terminal) the same way. `⌘ ⇧ '` opens the active chat's Files tab without the close-if-already-open half (a dedicated open, matching `⌘ '`'s own dedicated-open diff shortcut beside it). All three are scoped to a chat view and read past a focused text field, on the same reasoning as the three above.

## Sidebar

The sidebar is the only multi-session navigator. Top to bottom:

1. Brand row: the `patch` wordmark (Fraunces italic) leading the row, with a single connection dot (green when host connected, orange when offline) set as a superscript on it — one mark carrying a state, not a mark and an indicator. At the row's far right, clustered together, an icon that opens the sidebar in its own window (§ New windows) and the collapse chevron (`‹`), sitting close to the sidebar's own edge. Clicking the chevron collapses the sidebar (see § Layout — desktop above); there is no other click target for it, since the whole `aside` unmounts once collapsed. The two icons keep their full size at every sidebar width and always sit within the sidebar: the sidebar clips its own overflow, so anything pushed past its edge is both invisible and unclickable. The wordmark and its dot are what yield, truncating at the narrowest widths.

1b. View dropdown — one pill + pop-up (`All chats ▾`), directly under the brand row, sized to its own label rather than stretched to the row's width. This is the sidebar's own view switch — not a global top bar — and the only thing that decides what the chat list below shows: `All` · `Unread` · `Working` · `Waiting on you` · `Failed` · `Batch`. Picking an option is exclusive — it is always exactly one of the six, never two filters stacked:

- `All` — nothing is filtered.
- `Unread` — the needs-attention queue (see § Chat lifecycle → Unread below): Pinned + Folders only, filtered to rows that need you and re-ordered FIFO, holding the chat you're looking at until you move on.
- `Working` / `Waiting on you` / `Failed` — narrows Pinned + Folders to rows in that one state (§ Status badges), leaving Channels, Recent projects, Archived and Deleted showing — these ask "what's in this state", not "what needs me", so the rest of the list stays reachable. Driven off the same `deriveBadge` the row's own icon uses (`working`/`background`/`monitoring` for Working; a `permission` badge or a declared question for Waiting on you; `errored` for Failed), so what you filter for and what you see on the row can never disagree.
- `Batch` — swaps the list for the batch review view (see § Batch mode). The option carries a count badge when the batch is non-zero, the same number the batch view itself lists.

The trigger reads `All chats` at rest and the chosen option's own label otherwise (`Unread`, `Batch`, …), and carries the same active/accent treatment as any other engaged filter chip. The choice persists per-user across reloads, the same as every other standing sidebar preference (column widths, collapsed folders). No new keyboard shortcut selects it; there was none to carry over.

2. Manager — single row, name in semibold, no status glyph (distinguished by being the only first-tier slot). Three always-visible controls sit on the right, side by side: Voice note (tap-and-hold mic, records a note and sends it to Manager), Call (opens a `call` voice session on Manager) and Hands-free (opens a `hands-free` voice session on Manager) (`07-voice-app.md` § Session modes). All three are icon buttons with a hover tooltip naming them, carrying no extra text — the same icons and behaviour as those controls elsewhere (the row mic, Call in the composer, Hands-free on the phone's Manager card). While a session is open, Hands-free reads as active and ends it on another click; Call does not toggle — ending a call is the open session's own control (the VoiceBar), exactly as it is everywhere else a call can be started. Every one of the three always targets the Manager thread, regardless of whichever chat is open in the main panel — the row they sit on IS Manager's, never the active chat's. Manager is the only special thread in this top-of-sidebar slot. See `06-threads-manager-speakers.md` § Sidebar placement.

3. Pinned chats — any user-pinned regular chat (see `04-chats-and-folders.md` § Pinning). A pinned row is drawn exactly like an in-folder row: the same status badge column, name, preview, and the same one top-right slot behaving as § Row tools describes. The only addition is a small accent pin glyph immediately left of the name, marking the pinned state at rest without taking room in that slot; unpinning is the pin button in the row's hover tools, as on any other row. The state is marked beside the name rather than by holding the actions open because actions parked in the slot both cover the time and halve the width left for the title — the chats singled out as important would be the only ones that could not be read. A subtle hairline separator divides the pinned section from the folders below.

4. Folders — a section label (uppercase tracked, semibold, ink-3 grey) followed by the folder's chat rows. The label is the project name (the folder's basename, e.g. `portfolio`), with the full absolute path on hover. The label doubles as a disclosure control, with a chevron beside it: clicking it collapses the project, folding its rows away and leaving the header carrying a muted count of the chats it now hides, drawn like the counts on the collapsed sections below. Collapse is per project, keyed on the folder's full path rather than its name, since two projects can share a basename. It persists across reloads for that browser, and a collapsed project's rows are out of the shift-click order (see Selecting multiple rows) — a range is only what the user can see. While the view dropdown (§1b) is on anything but `All`, collapse is suspended and every match is listed; the collapses return when it comes off, so a filter can never read as having missed a chat. Two hover-revealed archive buttons sit on the header, and they are deliberately not the same action. The first archives the project AS LISTED — the rows drawn under this header — which is the everyday "done with this lot" action. The second archives ALL in the project: every chat in the folder, including the pinned and snoozed ones that are drawn in their own sections (Pinned, Snoozed) and so are NOT under this header. The distinction earns its place because the listed rows are not the whole project: a pinned or snoozed chat survives the first button and leaves the project half-archived, which reads as the archive having silently failed. Special threads are never included by either (they can't be archived), and neither disturbs already-archived or deleted chats. Each is the same reversible per-chat soft-archive (restore individually from Archived), and once all are archived the folder drops out of the active list. Both confirm first (they move many chats at once), and the confirm states how many chats will move — that count is what tells the two apart at the moment of use. A third hover-revealed control, a clock icon, snoozes the WHOLE project in one action (`04-chats-and-folders.md` § Snooze: "Whole-project snooze") — opening the same Gmail-style preset menu the chat header's own snooze control uses (§ Chat panel header → Snooze), anchored under the icon. There is no "as listed" snooze to go with it: archive needs the distinction because a pinned or snoozed chat surviving the narrower button reads as a silent failure, but there's nothing a project-wide snooze could half-do — it reaches the same whole-project set the wide archive button does (pinned and already-snoozed chats included, special threads and already-archived/deleted chats excluded) every time, so one control is enough. Picking a preset applies it immediately, with no confirm: unlike archive, snoozing doesn't move a chat out of the project or lose anything a wrong click can't undo with one more click (Unsnooze). Folder and row order follow § Sidebar ordering. Each in-folder row carries a status badge (left), name + preview (middle), and one top-right slot holding the `when` relative time, with the hover-revealed action icons overlaying it (see Row tools). The preview spans the full row width below the name and wraps to multiple lines rather than truncating to one. Row title + preview are plain text — markdown is stripped, so a reply full of `**`, `|`, `#` etc. shows as flat text, not raw syntax. The row title is the chat's AI-summarised name (see `04-chats-and-folders.md` § Name): a short Title-Case summary of the first exchange, produced once by Haiku after the first response. Until it lands the row reads "New chat" — never the folder basename (it would be identical for every chat in the project) and never the first user message. The first-message `preview` snippet remains a distinct secondary line, so rows sharing a folder stay distinguishable before the title is generated.

4b. Recent projects — below the open Folders, a compact list of folders that are NOT already shown above (e.g. every chat in them is archived), most-recently-active first. Drawn from the folder roster (`04-chats-and-folders.md` § Folder roster), so a project survives archiving its last chat and reloading. Each row is an entry point: clicking starts a new chat in that folder; a hover-revealed × forgets it. Rows show the folder NAME only, growing a disambiguating parent segment (`…/parent/name`) only when two recents share a basename. The section heading is `Recent projects` — user-facing copy calls a folder a project (same rule as the Folders label, whose text is the project name), so a heading the user reads carries the project name. The same rule applies to the new-chat folder picker's recents section (§8) and its empty state (`No recent projects`).

5. Channels — bordered box separated from the folders, collapsed by default, sitting just above Archived. Its toggle carries a muted count of the rows it holds, on the same rule as the cold-storage group below it. Click the chevron to expand → reveals one row:
   - Speakers — voice-device transcript. When a device is mid-session, the row carries a small green pill (e.g. `🎙 kitchen`) on the right.
     A passive log, displayed read-only. See `06-threads-manager-speakers.md` § Sidebar placement.
     The row is always a link to its thread and stays listed regardless of archive state — special threads are pinned Channels surfaces, so the server's chat list always includes them (Manager/Speakers) even when they've gone quiet and archived. They appear in Channels, not under Archived.

6. Hidden, Archived, Snoozed, Deleted and Automations — the cold-storage group. One row of five icon-only buttons (App Updates: "show as single icon buttons on bottom row"), evenly spread across the sidebar's width so they read as one toolbar rather than five unrelated controls, with a hairline (the row's own `border-top`) marking it off from the chat list above in addition to the clear space that already separated them — a divider you can see, not merely a gap you might mistake for one. Each button's label and count live in its hover/focus tooltip (native `title`, the same mechanism every other icon-only control in the app uses — § Copy) rather than being drawn on the row: "text and number on hover, [icon] click to open." Whichever button's section is currently open carries the `active` state (App Updates: "show which icon is selected as open") — the same accent-tint fill, accent border and tinted glyph every other selected control in the sidebar uses (the view dropdown's trigger when it isn't on `All`, the bottom nav's current page) — so a glance at the row says which section, if any, is open below it. Each button is its own independent toggle, not a single-select group, so more than one can carry `active` at once when more than one section is expanded together. The count is served as a standalone total (`04-chats-and-folders.md` § Section counts) rather than measured from the list, which holds only the sections already expanded; it stays live as chats are archived, snoozed, deleted, restored and spawned, and a `null` total (the boot fetch hasn't landed, or it failed) draws no count segment in the tooltip at all — the label alone, never a stray `0`. Clicking a button opens its list directly beneath the icon row (see Chat lifecycle) — an expanded list sits closer to the icon row than to the chat list below it, so it reads as belonging to the group, not to whichever button happens to be lit. Each of the five lists (App Updates: "load a limited number... then load more on scroll") fetches one page on expand rather than its whole cold-storage history in one request; scrolling the list's own capped band (§ Scroll regions below) within reach of its bottom fetches the next page and folds it in, exactly as the first page did, and stops asking once the server reports nothing further. This holds inline here and in the same section's `/lifecycle/:kind` main-window view (§ Routes) — one list, one paging behaviour, wherever it's drawn — and applies equally whether the section is still growing (a scroll load added rows) or already complete (nothing left to fetch, so scrolling to the bottom just does nothing further). A section that is open and non-empty grows a small head above its list carrying the label again (the icon that opened it has no on-row text to point back to) and a link to the same section at `/lifecycle/:kind` (§ Routes) — "can also open in main window" — for browsing a long list in the main panel's room rather than the sidebar's capped, scrolling band (§ Scroll regions below). The head also carries a filter box: typing narrows that section's rows to those whose name or first-message preview contains the text, case-insensitively; Escape clears it. The filter only sees loaded rows, so while it holds text the section keeps fetching the remaining pages without waiting for a scroll. It is local to the section (not the global chat search) and exists inline only, not in `/lifecycle/:kind`. An empty or not-yet-counted section grows no head: there is nothing a bigger view would show that the tooltip hasn't already said, and the empty-state rule below still wants a `0`'s only cost to be the icon row it already paid for. A load failure still reports itself below the icon row, whether or not a head was drawn: that is information, not absence. `▸ Automations` lists every chat a job created — a `spawn` action's fresh chat per fire, or an `ensure` action's durable one (`08-triggers-and-jobs.md` § Action) — independent of the chat's own archived/active state. `▸ Hidden` lists chats running out of the way (`04-chats-and-folders.md` § Hidden) — usually a job's runs whose action sets `startHidden` — each row carrying the usual status badge plus an Unhide control that moves it into the active list; the chat panel of a hidden chat carries a Hidden banner with the same Unhide. Each row carries the same status badge as everywhere else (`done` / `permission` / `working` / `background` / `read`), which is the point: glancing at `▸ Automations` shows which background runs are still going and which finished, live, without opening anything. Ordered FIFO — oldest first, newest at the bottom — not most-recent-first: several runs are often working/updating at once, and inserting each activity tick at the top would reshuffle every row below it, over and over, while a batch is in flight. A run already in the list rejoining the back of it on update, instead of jumping to the front, is what keeps the list from visibly cascading downward as it loads (same rationale as § Chat lifecycle → Unread's FIFO queue).

7. Bottom navigation — `Jobs` and `Settings` as plain rows with lucide-style SVG icons. The active page (e.g. on `/settings`) gets the `active` class with the accent-tint background.

Scroll regions. The sidebar's chrome is fixed and always on screen; only the chat list scrolls. The `aside` itself is fixed. Three bands:

- Fixed top — brand row, the `+ New chat` button, the view dropdown (§1b), the chat search field (§ Chat search), the Manager row, and the selection bar while a selection exists (§ Selecting multiple rows (shift-click)).
- Scrolling middle — pinned chats, Drafts, Folders, Recent projects and Channels. This is the only region with `overflow-y: auto`; it takes all the leftover height and shrinks as the fixed bands need room.
- Fixed bottom — the Archived, Snoozed, Deleted and Automations lifecycle controls and the bottom nav (`Jobs`, `Settings`).

No matter how many chats exist, `+ New chat` (top) and the lifecycle group (bottom) stay in the same place, reachable without scrolling. The chat list is the only band that yields: a growing chat list scrolls within the remaining window height, leaving the lifecycle controls at full height, which always render at their full collapsed height. An expanded lifecycle list is itself capped — the lifecycle group takes at most a third of the sidebar, and never more than 300px — and scrolls within its own region rather than pushing the nav off-screen; when collapsed, the group is exactly as tall as its four rows and nothing inside it is hidden. The cap is what keeps expanding a cold-storage section from being the same thing as closing the chat list: the list still shows several rows with all four sections open. The batch and manager views follow the same rule: their panel is the scrolling middle band. A fixed band claims only the height it needs, because every pixel it claims comes out of the chat list: two adjacent controls in a fixed band are separated by one gap — the separation that pair is designed to have — never by both of their margins stacked.

A band that is scrolling says so. The sidebar's bands are short enough that even two drafts and one chat overflow the middle band in an ordinary window, so clipped content silently reads as absent content: the middle and lifecycle bands draw the app's own scrollbar — a borderless rounded thumb filling the gutter they already reserve — for as long as they overflow, never a platform scrollbar that is painted only while the pointer is already scrolling. Content that arrives while a band is scrolled away from that content is scrolled to. Expanding a collapsed section brings the section — its header and the rows it just revealed — into the band, rather than drawing the rows below the fold and leaving the section reading as empty; and a newly saved draft brings the Drafts header into view with it. Scrolling to something never moves anything else: only the band moves, and only far enough.

One column. Every row and toggle in the sidebar — chat rows, Manager, Channels and its channel rows, the recent-project rows, the chat search results, the batch rows, the bottom nav, `+ New chat` and the chat search field, and the empty-state lines that stand in for rows — starts and ends on the same two vertical lines, so their hover and selected highlights read as one column instead of ragging down the right side. That inset is defined once and shared; a row does not get to pick its own. Two consequences follow. A row nested inside a box that already carries the inset (a channel row inside the Channels box) does not indent its box any further — it shows its place in the hierarchy by starting its LABEL further in, which moves the text without moving the highlight. The view dropdown (§1b) and the cold-storage icon row (§ Sidebar item 6) are the controls that are not on this column: the dropdown is sized by its own label rather than by the sidebar, so it shares the column's left edge and has no right edge to share — stretching it to the full width would give one short label the footprint of the row below it; the icon row is five square, self-contained buttons in the same class as the brand row's own icons and the sidebar collapse chevron (§ Sidebar item 1) — a toolbar, not a text row, so its individual buttons don't carry the column's edges even though the row's own container does. The chat search field, now the fixed top band's only other control besides the dropdown, fills its own row and ends on the column's right edge, so search costs the chat list no height. And the scrolling bands reserve the width their scrollbar takes whether or not it is showing: otherwise every row in them sits a scrollbar's width left of the fixed bands' rows the moment the list is long enough to scroll, and shifts sideways as the list crosses that threshold.

Model selector. A new chat carries a model picker beside the folder pill, in the chat body under the New chat empty state (see § New-chat setup row below) — not in the header. The list of selectable models is live: the surface loads it from `GET /api/models` for the chat's chosen host, which the server round-trips to that host; the host reads each provisioned backend's models endpoint with the credential it already holds and re-reads it on a TTL, so a newly released model appears without a redeploy and a retired one disappears (`02-daemon.md` § Model catalogue). It offers those models newest-first (there is no synthetic Default model row; the picker preselects the draft's model, else the chosen host's last-used one). The list is always live: until the catalogue loads the pop-up reads `Loading models…`, and a failed load reads one plain sentence saying what to do about it, with the host's own code kept in a collapsed Details disclosure beneath it (`12-error-and-offline.md` § Principles), so the picker always reflects the real set. The pill itself always shows the chosen model id, so a chat can still be spawned while the catalogue is unavailable. The choice is per-chat and applied at spawn (forwarded as the SDK `--model` override on `POST /api/chats`), and it persists on the draft. A live chat's model is changeable too, and by the same control: the model crumb in the chat header is that pill, opening that pop-up over that catalogue, so the app has one model control rather than two. Choosing there applies from the chat's next turn (`04-chats-and-folders.md` § Model), and while a turn is running the pop-up says which turn it will affect — a switch presented as instant would misdescribe the reply streaming underneath it. The pill shows the new model as pending until the host confirms it in the chat's state, then settles on it; a host that never confirms has not switched, and that is said out loud as an error naming the host, rather than leaving the pill reading a model the chat is not running. The model picker is the same custom pill + pop-up control as the folder picker. The two sit side by side in one row, so a native dropdown next to a custom pill reads as two different apps: the model control is a pill button (label + `▾` caret) that opens a list of options with a `✓` on the current one, matching the folder pill's shape, radius, type scale and hover/selected treatment. Only one of the two pop-ups is open at a time — opening the model list closes the folder picker, and vice versa. Choosing an option sets the model and closes the list; clicking the pill again while its list is open closes it.

Account selector. Beside the model picker on a new chat, when the chosen model's backend has more than one connected account, a select names the account the chat's turns start on (`10-auth.md` § Backend credentials — preferred account): `Account: by strategy` first and chosen by default, then `Start on <label>` per connected account. It follows the model: switching to a model on the other backend clears a choice that belongs to the first. On a live chat the header shows, after the model crumb, the label of the account its latest turn ran on (`chat.state` `account`), as a muted segment with the full sentence on hover; it is not a control, since the preference is fixed at spawn.

Dismissing pop-ups (click-off). Every anchored, non-modal pop-up — the folder picker, the model picker, the sidebar's view dropdown (§1b), the sidebar row's context menu (§ Row context menu) and the composer's skill autocomplete — closes when the user clicks (or taps) anywhere outside it, and on Esc. Clicking off is the universal "I'm done with this" gesture; a list that stays open because the click landed on empty chat body reads as a stuck UI and obscures what is underneath. The rules: a pointer-down outside both the pop-up and its own trigger closes it (the trigger keeps its own toggle behaviour, so a click on the pill closes-by-toggle rather than closing twice); a pointer-down inside the pop-up leaves it open, so scrolling the browse tree, typing in the ad-hoc path field or clicking a section heading all leave it open; and closing this way changes nothing else — no folder/model/skill is selected, no text is cleared, exactly as Esc behaves. This applies to whichever pop-up is open, on web and desktop (mobile's anchored menus already dismiss on a backdrop tap — `15-design-mobile.md`). Modal overlays keep their existing backdrop-click behaviour (§ Modals).

New chat drafts. An unsent new chat is a draft — a chosen folder + composer text the user isn't ready to send. Drafts persist across navigation and reloads and the SERVER owns them, exactly as it owns composer drafts (§ Composer): a draft with text is saved to the server shortly after a pause (`new_chat_draft.set`), reaches every other open surface live (`new_chat_draft.updated`), and is in the snapshot a surface gets on connecting (`new_chat_draft.list`, sent even when empty so a draft deleted elsewhere while the surface was away is dropped). Discarding or sending one anywhere removes it everywhere (`new_chat_draft.remove` / `new_chat_draft.removed`), and it stays removed across a server restart (`<dataDir>/new-chat-drafts.json`, written atomically; a corrupt file is logged and read as empty). `localStorage` is only an offline cache; a draft typed offline or before this existed is pushed up on reconnect. Blank drafts are local scratch and are never sent. The user can keep several and the user can keep several and switch between them: each `+ New chat` mints a fresh draft (leaving any in-progress one intact), and a Drafts section in the sidebar lists every draft that has text. A draft is only a draft while it HAS text: text that is empty or whitespace-only is no text at all, so a blank just-opened draft isn't listed, and neither is one that was typed into and then emptied again — the row goes with the words. A new chat with no message is not something the user kept, so it is not merely hidden but collected: blank drafts are dropped whenever a new-chat session starts (the `+ New chat` button, the header's New chat icon, or opening `/chats/new`), sparing only the draft the screen is currently on, which still owns its chosen folder and model until it is left. A draft row shows the text as its title and the folder basename beneath; clicking it reopens that draft (`?draft=<id>`), and a hover × discards it. A draft is consumed — removed — the moment its first message is sent (or a header action spawns it); until then it survives everything. A header action that spawns it carries its text into the new chat's composer. A chat spawned before anything was sent into it — by a header action, a voice note, or a send whose attachment upload then failed — is deleted (the same soft-delete as Delete chat) once the user leaves it with no message in it, no words in its composer and no call or voice note running on it: an empty chat is not something the user kept. The active draft is pinned to the URL so a reload lands back on it.

8. `+ New chat` button — full-width, dark fill, at the TOP of the sidebar: the first control under the brand row, above the view dropdown (§1b), Manager and the chat list. Starting a chat is the most-reached-for action in the app, so it leads the fixed top band rather than trailing the bottom nav. It is part of the fixed top chrome and is present in every sidebar view — regular, batch and manager. Opens a fresh chat directly in the main panel, with no intervening modal or wizard. A caret segment joined to its right edge (one segmented button, hairline seam) opens a dropdown holding New chat in new window (§ New windows); Esc or a click off closes it. The machine is chosen first: with more than one host registered, the setup row opens with a line of its own holding one toggle per host, by host name, the home host first; with one host there is nothing to choose and the line is absent. An offline host's toggle reads `<name> · offline` and is disabled. The folder is then chosen from a folder picker that pops up from the new-chat setup row (see below), listing only the chosen host's folders (`04-chats-and-folders.md` § Folders): that host's configured project folders (Settings → Project folders) first, then folders seen in recent chats on it — that combined list is headed `Recent projects` (and its empty state reads `No recent projects`; §4b) — plus a free-text field for an ad-hoc path on that host. The quick project toggles and the browse tree are the chosen host's too. Changing the host keeps the folder only if the new host has a folder at that path, and the browse tree returns to the new host's roots. The (host, folder) pair is what the spawn sends as `daemonId` + `folder`, and it is fixed for the chat's life. Defaults to the (host, folder) and model of the last NEW chat created from this screen — recorded only on that creation (never by a job, a hidden thread or a continuing chat) and read once on open, so it never moves while the screen is showing; before any new chat has been created, the newest project chat seeds it. A recents row is a toggle: clicking the row that is ALREADY selected deselects it — the folder clears back to `Choose a folder…`, no folder is chosen, and the pop-up stays open (nothing was picked, so there is nothing to close on), with the `✓` and selected treatment gone. This is the escape hatch from the most-recently-used default: without it a preselected folder could only be swapped. The model picker has no such toggle — a chat always spawns on some model, so re-clicking the current model just closes the list. Each picker row (and the browser breadcrumb) shows the folder NAME (basename) as its primary label — the full absolute path is muted secondary text and a hover tooltip: a wall of full paths is too hard to scan. The breadcrumb renders ONLY once the user has drilled into a directory. At the roots view there is no current directory, so no breadcrumb is drawn; the `Browse` heading alone labels it. A picker pop-up opens above or below its pill, whichever side has room, staying clear of the composer; it scrolls as one region when its contents exceed that room, so every row — recents, the browse tree, and the ad-hoc path field — is always reachable. The picker also browses the host's directory tree (`04-chats-and-folders.md` § Browsing) — and the browsed filesystem is always the host's, on every surface. The Electron desktop app must NOT use the OS-native directory dialog: it browses a different machine's disk, so every folder it returns is a path the host does not have. Desktop shows the same in-app tree + type-a-path field the browser SPA shows. Composer auto-focused. New-chat setup row. Before the first message there is nothing to read in the transcript, so the two things you must decide — project (folder) and model — sit inside the chat window, in a single centred row directly beneath the New chat empty state, where the eye already is and next to the composer they feed. The new-chat header carries no folder pill and no model picker: it is title + Editor only, the same shape as a live chat. It carries a usage crumb beside Back/Forward (§ Chat panel header) that a live chat's header no longer does — a live chat relies on its composer's context ring instead, but there is no chat yet here for a ring to measure, so the crumb stays on this screen, reading the account the setup row's chosen host/model resolves to rather than anything the chat itself would need to exist for. After the first message the setup moves up: the chat now exists, the transcript owns the body, and the chosen folder reads as the quiet line under the header's title exactly as on any live chat, and the model stays selectable (§ Model selector). The setup row is therefore a pre-send affordance only; it appears only before the first message. Because a new chat has no session yet, each action spawns the chat in the chosen folder first, then runs (create-then-act); with no folder chosen the action opens the folder picker instead. The three most recently used projects also sit in the setup row itself, as toggle buttons alongside the folder pill: picking up where you left off is the commonest thing this screen does, and through the pop-up it costs an open-then-choose round trip. Newest first, and where fewer than three projects have been chatted in the row is topped up from the head of the picker's list, so the buttons are always a shortcut into that list rather than a second source of projects. A button shows the project name — growing the same disambiguating parent segment its pop-up row would, with the full path as its tooltip — and clicking it selects that project and its host exactly as the pop-up row does; clicking the one already selected deselects it, the same toggle. The pill and its pop-up are unchanged, and remain the way to reach the rest of the list, to browse, and to type a path. No projects to offer, no buttons. The model carries the same shortcut, on a line of its own beneath the pills: the three most recently used models as buttons, newest first across the chats the user started and topped up from the head of the catalogue where fewer than three have been used — a chat a job created runs on the job's model and a special thread on the special-thread model, so neither counts as a model the user last chose; each reading the model's catalogue label. Only models the catalogue offers appear, so these too are a shortcut into the pop-up rather than a second source, and an unloaded or failed catalogue leaves the line empty. Clicking one chooses that model exactly as its pop-up row does, with no deselect (§ Model selector). Left and Right walk either row while one of its own buttons has focus, wrapping at the ends, selecting as they go and carrying focus with the selection; the keys reach the row only through its buttons, so they never take the cursor from the composer. A bad/ad-hoc path still reports the host's refusal on send and restores the typed message; a spawn that fails for any reason reports it as one error toast and nothing else, said in plain English with the code kept (`12-error-and-offline.md` § Principles). On send, the freshly-created chat is rendered immediately — the client optimistically seeds the chat row (with the chosen folder) and the user's first message, then navigates straight into the transcript. It holds the transcript view while waiting for the host's `chat.spawned` to arrive; the spawned/state events reconcile the row in place. A voice note can also start the chat (the composer's mic on a new chat): the client creates the chat, navigates into it, and binds the voice note to the new chatId so the host routes the transcript in as the first turn. Because the new-chat composer unmounts on navigation, this first note always runs as a toggle session (commit `⏎`, cancel `esc`) — a press-and-hold release couldn't survive the route change.

### Sidebar ordering

Pinned and Folders rows sort by the user's own last activity on each chat — when they last sent a message into it (composer, voice note, fork or side message), or its creation if they never have — never by whichever update landed last. An agent reply, a status change, a job tick or a finished turn bumps the chat's `lastUpdated` but not this, so none of them moves a row while the user is reading or clicking elsewhere in the list; a user message does, straight to the top of its folder.

A folder is ordered by the same measure, taken as the max across its chats: the project the user most recently sent into leads the list, not the one an agent happens to be busiest in right now.

The default is **Last action** (above). The view dropdown (§1b) also offers two independent sort choices, "Sort chats by" (rows within a project) and "Sort projects by", each one of Last action, Last update (any activity, including agent replies) or Name (A-Z; a project sorts by its folder's basename). Both persist across reloads for that browser. The Mini sidebar and archive-next-chat navigation follow the same choice. Pinned order is unaffected.

The status badge (§ Status badges) is what shows a chat needs attention, never the row's position — a `permission` or `working` badge does not pull a row to the top of its folder.

Pinned is its own axis, ordered by `pinnedAt` (`04-chats-and-folders.md` § Pinning) and unaffected by either kind of activity. Special threads (Manager, Telegram, Speakers) keep their fixed slots (§ Sidebar items 2, 5). The Unread view (§1b) replaces this ordering with its own FIFO queue (oldest-waiting first) while it is the active filter.

### Status badges (the inbox model)

The list is an inbox: badges are read/unread, not done/in-progress.

| Visual                                        | State           | Meaning                                                                                                       |
| --------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| Plain orange dot, fading in and out (no glow) | `working`       | Agent is producing output right now.                                                                          |
| Indigo dot with a thick, crisp indigo ring    | `permission`    | Agent paused on a tool-use approval prompt, or a declared `question` (`patch_ask_human`) — needs a decision.  |
| Solid accent dot with a soft tint halo        | `done` (unread) | New activity since you last visited. "Check me."                                                              |
| Static grey terminal glyph                    | `background`    | No turn is in flight, but a background command or sub-agent the chat launched is still running.               |
| Static grey clock                             | `monitoring`    | No turn is in flight; the agent has a self-wake (`patch_wake_me`) armed and will check back on its own.       |
| Darker ✓ tick                                 | `read`          | You've visited since the last activity. Row name + preview subtly greyed so the eye finds active stuff first. |

The unread `done` dot is a solid accent (green) dot with a soft `accent-tint` halo. The `read` tick is rendered larger and in the darker `ink-3` so it's legible at sidebar size.

Every state draws at the same footprint — the 8-9px dot the row reserves a track for, with no padding or margin of its own. Only hue and shape vary between states; a badge that grows its own box pushes the row title out of place and stops reading as a status marker.

Every badge state carries its own hue: `working` is orange (`--waiting`), `permission` indigo (`--permission`), `done` the accent green, `read`/`background`/`monitoring` a grey tick/terminal-glyph/clock — the last two draw in `--ink-3`, the same grey as `read`, not `working`'s orange. `background` and `monitoring` used to share `working`'s orange (a turning ring, distinguished by shape alone) — reverted: a spin is the single strongest "happening right now" cue in the list, and it belongs to `working` alone. Diluting it onto a background job that needs no attention until it reports back made the two compete for the same glance instead of one calmly outranking the other. `background` and `monitoring` differ from EACH OTHER by glyph, not colour — a terminal glyph for an actual process running, a clock for "nothing running, will check back on its own" — since both are equally quiet and only the shape says which kind of not-finished this is. (An eye was tried for `monitoring` first — dropped: Tom, "the eye is more like 'something for you to look at' than seen", the opposite of a state that needs nothing from the reader right now. A cog was tried for `background` too — dropped, as it already means Settings everywhere else in the app.) `permission` and `working` were once both orange too — separated by shape alone: a crisp hard-edged ring against a plain dot fading via opacity. That was not enough either. At the 8-9px the sidebar draws these at, a 2px ring versus a slow fade is the weakest signal in the list, and it was carrying the one distinction that actually changes what you do next: whether the agent is busy (wait) or blocked on you (act). Colour now does that work and shape reinforces it, rather than shape doing it alone.

`--permission` is a cool indigo because the rest of the palette is warm (green, orange, terracotta), so nothing else in the sidebar can be mistaken for it at badge size; red was avoided because a blocked prompt is not a failure. It is the only cool hue in the palette, and that is the point — see § Theming.

When the pending request carries a deadline (`chat.permission_request`'s `expiry`, `03-wire-protocol.md`), the `permission` badge's outer ring drains toward it instead of sitting fixed — Tom: "this blue outer circle should go down along with the question timer its waiting on." It is the same deadline the open chat's own question-prompt countdown ring counts down to (§ Main chat panel — Question prompts), so a row's badge and its card, once opened, empty together rather than telling two different stories about how long is left. A request with no deadline — a declared `patch_ask_human` question, or a host with question expiry turned off — keeps the fixed ring; there is nothing to animate toward.

**Unread beats `background`/`monitoring`, always.** A background job still running, or a self-wake still armed, does not make fresh output any less unread — there is something new to look at, and that stays the strongest true claim available below `permission`/`errored`. `background` and `monitoring` rank below `done` for this reason and above `read`: each stands in place of the tick, because a chat with work still in flight has not finished and the tick is the strongest "nothing to do here" signal in the list — the one case where it was wrong. Between the two, `background` outranks `monitoring` (an actual process running is a stronger claim than an armed timer). Both answer the `working` state filter, since both are work in flight just not a turn, and neither is an attention state, since a chat that has not finished is not yet a result to look at. Neither changes where the row sorts — promoting either would make a row jump up its folder the moment the agent backgrounded a command or armed a wake, and back down when it settled.

The count behind `background` comes from the chat's host (`02-daemon.md` § Background task completions), not from the transcript: the sidebar holds every chat and the transcript of none. A host that reports no count leaves the row's badge exactly as it was — an absent count is unknown, and never read as none running (`principles.md`). `monitoring` reads directly off `chat.state`'s `pendingWake` (§ Self-wake, `02-daemon.md`) — present means armed, `null` means nothing pending.

A chat working toward a goal (`04-chats-and-folders.md` § Goals) carries a small `◎` beside its badge, not instead of it — the badge still says what the TURN is doing (working/permission/done/…), the `◎` says the chat is additionally being held to a condition across turns. Reads straight off `chat.state.goal !== null`. It does not rank or filter like a badge state; it is purely informational, and it is gone the instant the goal resolves or clears.

`working` keeps its shape treatment: no box-shadow at all, fading in and out via opacity. A soft blurred glow used to sit here but read as fuzzy rather than pulsing, so the state is colour + a clean opacity fade only, and the fade still reads as motion — "still going", as against a "fresh result to look at".

### Row tools (time + actions)

The relative time and the row's action icons share ONE top-right slot on the row's first line — both anchored to the row's top and to the same right edge. The time is what that slot shows at rest; the actions — archive · pin · mic, in that order — are revealed on row hover and go over the time, taking its place rather than sitting in a second column beside it. Because it is one slot and not two, revealing the actions moves nothing on the row: the badge, the name's left edge and the slot's right edge all stay where they were. The slot is only ever as wide as what is currently in it, so at rest the chat name runs the full width up to the timestamp and ellipsises only when it genuinely runs out of room — never held back by space the hidden actions would need. The name re-clips while a row is hovered and the actions are showing, which is the right way round: the list is read at rest, and the actions are only on screen while the pointer sits on the row that owns them. Because hovering a row is what clips its name hardest, every row carries its full title as a hover tooltip (§ Copy) — otherwise the one gesture that asks to read a row is the one that makes it least readable. The time is hidden only while the actions cover it, and returns the moment the pointer leaves. Every icon button carries a visible hover state (accent glyph on a soft-tinted, accent-bordered chip).

- Archive — archive / unarchive this chat (spec/04 § Lifecycle). Hidden for special threads (they can't be archived).
- Pin — pin / unpin; a pinned row's control reads as active (accent). Hidden for special threads.
- Mic button — tap-and-hold to send a voice note to that chat without opening it. Press-and-hold OR a configured global hotkey opens the voice-note overlay (see `07-voice-app.md` § Overlay surfaces). Releasing or pressing `⏎` sends; `esc` cancels.

The row tools are hidden until row hover for regular chats, and always visible for the Manager row — there the tools own the slot outright, so the time is not drawn under them. A deleted row is the one exception to the overlay: it has no tools, so it keeps its time and shows a hover-revealed Restore next to it.

Keyboard focus reveals them exactly as hover does, so none of these actions is pointer-only (the same rule the edit-a-turn pencil follows). Tabbing to a row shows its tools, and Tab then walks through them in order — archive, pin, mic — with the time staying out of sight for as long as they are shown; a deleted row's Restore behaves the same. The reveal has to hang off the row rather than off the buttons: the tools are taken out of flow when hidden, and nothing inside a hidden subtree can be tabbed to at all, so the row is what gets focused first and brings them into reach. It is keyboard focus only. Clicking a row leaves that row focused, and treating that as a reveal would strand the open chat's row showing its action chips with its time hidden for as long as focus stayed there.

The folder header's archive buttons are faded rather than taken out of flow, so unlike the row tools they were always in the tab order — meaning "Archive all in this project" could be reached and fired on a button with nothing painted. They reveal on focus for that reason: a destructive bulk action is never triggerable from a control the user cannot see.

### Row context menu

Right-clicking a chat row opens that row's actions as a menu at the pointer, so one chat can be pinned, archived or deleted without opening it and without entering a selection. It replaces the browser's own menu rather than appearing alongside it. A row in Snoozed leads with Unsnooze; a row in Deleted offers Restore alone. Otherwise the menu leads with the three ways to open the chat the row already supports from a click (§ Panes and tabs § Opening things) — Open in new tab, Open to the side, Open in new window — followed by the actions the row and the chat header already have: Pin / Unpin, Snooze, Archive / Unarchive, then Delete last, carrying the same destructive treatment the chat header's menu gives its own delete. Snooze expands in place to the same presets as the chat header's snooze (§ Chat panel header → Snooze) and keeps the menu open until one is picked. Special threads have no menu, since none of these actions applies to them. Each item does exactly what the equivalent row tool, header action, or pane/tab gesture does, including the confirm before Delete and where archiving the open chat leaves you (see Chat lifecycle).

The menu opens at the pointer and stays whole inside the window: it slides left of the pointer at the right edge and flips above it at the bottom. It closes on Esc, on a pointer-down outside it (§ Dismissing pop-ups (click-off)), and on any scroll — it is anchored to a point rather than to the row, so a list scrolling underneath would leave it over a different chat holding the first one's actions. It is reachable from the keyboard: the platform's own menu key opens it on the focused row, anchored to that row; opening it moves focus to the first item, ↑/↓ and Home/End walk the items, ⏎ runs one, and closing it hands focus back to the row.

An event that changes no row does not invalidate the chat list. Grouping the sidebar is a sort over every chat, and the highest-volume event by far — one message delta per streamed token — touches the transcript, not the row. Applying live events is therefore identity-preserving: an unchanged row keeps its object, and when nothing changed the whole map is kept, so the sidebar does not re-render. Streaming a long reply costs zero sidebar row renders, at five chats or five hundred. The transcript counterpart is Transcript render cost is O(changed) below. Both are regression-tested by counting renders across a burst of deltas.

### Message context menu — Send to new chat

Right-clicking a settled user or assistant message opens a menu at the pointer (same behaviour as § Row context menu) offering Open side thread and Send to new chat. Send to new chat is for breaking a chat up: it opens a new chat on the same host and in the same folder as the source chat, with the quoted text in the composer as an unsent draft (each line prefixed `> `), composer focused so the user adds the instruction and sends. If text inside that message was selected when the menu opened, only the selection is quoted; otherwise the whole message is. Nothing is sent until the user sends it. Desktop web only; there is no mobile long-press equivalent yet.

### Selecting multiple rows (shift-click)

Archiving or deleting a run of chats one row at a time is the sidebar's most
tedious chore, so shift-click range-selects rows — the meaning shift already
has in every file manager and mail client, and the reason a shift-click on an
in-app link is swallowed rather than navigating (§ Links and the web panel).

- The anchor is the last row you plainly clicked. An ordinary click navigates
  as it always did AND sets the anchor, clearing any selection.
- Shift-click selects the inclusive range from the anchor to the clicked row,
  in the order the rows are drawn (pinned first, then each folder group, top to
  bottom) — not the order they were clicked, and within the range the user
  can't see. It does not navigate. Re-shift-clicking resolves the range from
  the SAME anchor again, so the selection grows and shrinks as you move down and
  back up, so the selection stays one contiguous range. Shift-clicking with no anchor
  selects just that row and makes it the anchor.
- Only regular chat rows in the list select. Manager, the Speakers
  channel, drafts, and the Archived/Deleted section rows are not part of the
  order and stay unselectable — they aren't things you bulk-archive.
- A selected row reads as selected — the `accent-tint` selected-row
  background and `aria-selected`, the same treatment the active row uses.
- A selection bar replaces nothing and hides nothing: while a selection
  exists, a bar reading `N selected` with icon actions — archive and delete
  (the friendly bin, § Icons) — and a × that clears the selection. No
  explainer copy (§ Copy — no helper text); the icons carry tooltips as
  icon-only controls do. It belongs to the fixed top band, directly above the
  chat list, not to the list itself: a range can run well past the rows on
  screen, so a bar that scrolled with the list would offer archive and delete
  for chats the user can neither see nor reach the controls for.
- Bulk actions are the single-row actions, applied to each selected chat. Both
  ask first, for the reason the folder header's archive buttons do (§4): one
  confirm naming the count, the app's own modal rather than `window.confirm`.
  On confirm, archive archives every selected chat optimistically, exactly as
  the row's own archive control does (a failure reverts that row and raises an
  error toast), and delete soft-deletes each (recoverable from Deleted). Either
  way the selection clears once it has been applied; cancelling changes nothing
  and leaves the selection standing.
- The selection is transient: `Esc` clears it, so does a plain click on any
  row, and it lives only for that view. A selected chat that leaves the list (archived,
  deleted, or gone) drops out of the selection rather than lingering as a
  phantom id.

### Chat search

The sidebar's search field (`Search chats…`) searches every chat on every host, by name and by what was said (`04-chats-and-folders.md` § Search). From two characters, the scrolling middle band shows results in place of the chat list; the fixed bands stay as they are. Clearing the field, or Escape in it, restores the list. Pressing a result also clears the field: it opens that chat AND restores the list, rather than leaving the sidebar stuck on a stale search.

- A `Full text` checkbox, unticked by default, sits at the top of the results band. Unticked, only chat names are searched (the local stand-in too); ticking it also searches message text and the request is re-sent; the previous scope's answer is not shown for the new one. A "quoted phrase" in the field matches exactly (`04-chats-and-folders.md` § Search).
- The request goes out once typing pauses (250 ms), and only the answer to the latest query is drawn. Until it lands, the band reads `Searching…` over an instant local match of the chats already loaded (name and preview); the server's answer then replaces it.
- A result row is drawn on the row column like any chat row: the chat's title with the matched terms marked, then the snippet with its terms marked (a user message reads `You:` first), then a muted line — host · where the chat lives (Manager, Channels, Pinned, the project name, Snoozed or Archived) · `Automation` for a job-created chat · how long ago, and how many more messages matched when there are others. Clicking it opens the chat at the matched message and clears the search (§ Main chat panel).
- A query with no hits reads `No chats match “<query>”.` A failed request reads `Search failed: <reason>` in the band. `More results` under the list loads the next page.
- Every host the answer says was not searched gets its own line under the results, hits or no hits: `<host> offline — not searched`, `<host> didn't answer — not searched`, or `<host>: <reason>`.

### Chat lifecycle

A chat moves through `running` → `unread` → `read` → `archived`:

- Mark-as-read: opening the chat marks it read (`·` → `✓`). Read is user-driven: a chat stays unread until you visit it. "Visit" means the tab is actually visible, not merely that its route is mounted: the open chat keeps marking itself read as activity arrives for as long as it's on screen (so a reply that streams in while you watch never shows a stale `done`), but that stops the moment the tab is backgrounded (phone locked, switched app, occluded desktop window) and resumes the instant it's visible again. A turn that finishes while the tab was backgrounded therefore still shows `done` — the green dot you'd have gotten had you not had the chat open at all — rather than reading as already seen.
- No auto-archive: a chat leaves the active list only when archived. A chat stays visible until it is manually archived — the inbox reflects exactly what you've chosen to keep, and history itself is retained (see `04-chats-and-folders.md`).
- Archive is sticky against merely opening it: an archived chat stays archived (off the active list) just for having new activity or being opened — archiving is how you take a chat off the home screen and keep it off while you're not talking to it. Sending a message into it brings it back to the active list, from any sender (your own composer, a job, another agent's `patch_send_to`) — a message landing in a chat is the chat coming back into play. The explicit Unarchive control (the chat panel's archived banner, or re-toggling the chat header's or the sidebar row's archive icon) does the same without sending anything. Activity while archived still surfaces via notifications regardless; that alone doesn't re-clutter the inbox.
- Manual archive: the open chat is archived from its header's archive icon (§ Chat panel header); any other chat by hovering its sidebar row, where the timestamp swaps to a small archive icon button (a lucide icon), or from that row's right-click menu (§ Row context menu).
- Snooze + Snoozed section: snoozing a chat (chat-header clock icon) takes it off the active list until its wake time, then it returns on its own — the sidebar's Snoozed row (beside `▸ Archived` and `▸ Deleted`) expands to list snoozed chats with their wake time and an Unsnooze control. A snoozed chat is still `active`, still runs, and still notifies; only its listing changes. Opening one shows a banner naming the wake time with Unsnooze on it. See `04-chats-and-folders.md` § Snooze.
- Soft-delete + Deleted section: deleting a chat is recoverable — the row moves out of the active list into a Deleted section (alongside `▸ Archived`) from which it can be restored. Nothing is hard-deleted from the surface.
- Automations section: orthogonal to the states above — a chat's `▸ Automations` membership is set by whether a job's `spawn` or `ensure` action created it (`08-triggers-and-jobs.md` § Action), and never changes once set. It doesn't move the chat between active/archived/snoozed/deleted; it's an additional, always-current view onto whichever job-spawned chats exist, wherever else they also sit.
- Greying rules: read rows are subtly greyed so the eye finds active stuff first. Archived rows, when shown by expanding the archive group, are not greyed.
- Unread: the sidebar's view dropdown (§1b), set to its `Unread` option. It filters the sidebar (Pinned + Folders only — Drafts, Recent folders, Channels, Archived, Deleted all hide) down to rows that need you (`done` or `permission` — the latter now covers a declared `question` too; § Status badges). Opening one of those rows marks it read, which would ordinarily drop it out of the filter — instead it stays in the filtered list, greyed exactly as any other read row (same Greying rules bullet above), until you navigate to a DIFFERENT chat. That navigation is what releases it; only one row is ever held this way at a time. This lets you clear the queue one at a time — reading a chat and then moving to the next removes the one you just left, rather than the whole row vanishing under the pointer the instant you click it. Within the filtered list, rows queue FIFO — oldest-waiting first — rather than the normal chat list's order (§ Sidebar ordering): `permission` rows lead (a paused yes/no is the stronger signal), then everything else queues oldest-updated first, so a row that updates again while still in the queue rejoins the BACK of it instead of jumping back to the front and reshuffling what you were working through.

### Batch mode

Batch mode exists to stop the one-at-a-time pinging of kicking off several chats and coming back to each as it finishes: press Batch once, go away, come back once. It is a view to switch to, not a lock — every chat it holds stays openable from the normal list exactly as before. A batch spans hosts: each row carries its own chat's host, and a row whose host is offline shows that state rather than blocking the batch. The batch is account-wide — the server holds it, not this browser — so every surface (web, phone) sees the same running batch and the same membership.

The view dropdown's `Batch` option (§1b) swaps the normal list for the batch view. The option carries a count badge of the current membership when non-zero.

A single `Batch` button starts a batch with a check-in choice: `15 min` / `20 min` / `30 min` (default 20), or `When all done` (capped at 30 min regardless). Membership is automatic, not curated: every chat the user starts or sends a message to while a batch is running joins it. There is no per-row toggle. A member can be removed with the row's `×`, which only drops it from the batch — the chat itself is untouched.

While the batch is running (from the moment `Batch` is pressed until it ends, below), member finish and failure notifications are suppressed account-wide, on every surface (spec/09 § Chat completion, § A turn that failed) — that suppression is the feature; nothing else about those chats changes.

Before check-in, the batch view shows the check-in time and the member rows, each marked only "waiting" — no done/unread/other state is shown, since the point is not to watch them one at a time — plus a `Check in now` control that checks in immediately without waiting for the time or for every member to finish.

Check-in happens at the first of: the chosen time elapsing, or (for `When all done`) every member finishing, or the user pressing `Check in now`. The first two fire ONE notification, `Batch ready: N done, M still running` (spec/09); `Check in now` does not, since the user is already looking at the view. Either way, from check-in on, the batch view lists members by their real status (done first) instead of "waiting".

The batch ends once every member that was ready at check-in (or became ready since) has been opened — opening a chat anywhere, not only from the batch view, counts. Members still running when it ends roll over: pressing `Batch` again starts the next batch pre-populated with them, on top of whatever new chats are started or messaged into after.

## Manager view

Opening Manager gives the main panel a second region: the Manager conversation on top, a Threads strip beneath it, split by a drag-resizable horizontal divider (threads 240px by default, persisted per-user). This is the sit-and-watch view — one conversation to talk to, and everything it is watching visible underneath without leaving it.

The Threads strip lists every active chat on every host, one row each, ordered needs-you first (`permission`, then an unanswered question, then a report, then `working`, then the rest by recency) — the same rule the sidebar's folders sort by, kept once in `@patch/wire` (`threadRows`) and shared with the phone's Manager Chats tab (`15-design-mobile.md` § Voice tab (Manager)). A row shows the status badge, the chat name, its host and folder, and its one-line status summary, and updates live. Archived, snoozed and deleted chats are not listed; nor are the special threads.

Each row's controls are the decision it is blocked on, taken without opening the chat:

- `permission` — Approve / Deny, the same pair the chat itself offers.
- question — the answer options, inline.
- idle — Carry on, which delivers a `continue` turn.
- any row — Open, and Stop.

The reach setting sits in the Manager view's own header, as a switch between `notify` and `auto-notify` (`09-notifications.md` § Reaching the user). It belongs here rather than in Settings because it is changed for a couple of hours at a time — before a drive, before an afternoon of plastering — not configured once. The switch names the state it is in, and every surface shows the same value, because the setting is the account's.

The strip has no scope picker. The Manager's sweep considers everything (`06-threads-manager-speakers.md` § The sweep), and a view that showed less than the thing doing the sweeping would be lying about what it can see.

Above the rows sits the sweep's own slim status line: "Last sweep 14:30 · nudged 2 · flagged 1" (or "No sweeps yet" before the first one, or "… · failed" when the last run's decision call errored). Clicking the line expands it into one row per chat the sweep acted on — the action it took and the chat's name, each opening that chat. A "Check now" button beside it forces an attempt immediately (`06-threads-manager-speakers.md` § The sweep — Triggers); nothing pending still reports no change rather than pretending to have swept. Sweep runs are also listed like job runs (`08-triggers-and-jobs.md` § Logs) via the same account-wide list the status line's expansion reads from — there is no separate "sweep runs" page.

## Main chat panel

Renders the live event stream with rich affordances:

- Transcript loads on open: opening a chat requests its transcript (a `chat.replay`), so a chat that first appeared after this surface connected — e.g. one spawned on the phone, surfaced in the sidebar by the always-on state-level fanout — loads its history and starts receiving live detail events rather than showing the empty state (see `12-error-and-offline.md` § When a surface requests a replay).
- Unknown chat: the route names a chat this surface holds no row for. Until the cold-start roster has landed the panel says only that it is loading, since every cold start passes through that moment. Once the roster is in and the chat is still absent, the chat is fetched by id — the roster is the active inbox, so an archived, snoozed or deleted chat opened straight from its URL is missing from it while still existing — and finding it opens the chat normally. Only a chat the server has no record of is a dead end. It is drawn centred in the chat panel: a title, the chat id, and two actions, back to Manager and retry the lookup. A lookup that fails for any other reason shows that failure's own message rather than claiming the chat is gone, and is equally retryable.
- Scroll position: the stream is a transcript, so opening a chat lands on the latest message (scrolled to the bottom), and while the user stays at the bottom new turns/streaming tokens keep the newest message pinned in view. Scrolling up turns following off the instant the user starts, and the auto-scroll stops even mid-stream; scrolling back to the bottom re-enables it. What counts is the scroll the user makes, not where it lands: while a reply streams in the content grows under them, so the start of a deliberate scroll up is still within touching distance of the bottom, and following judged on position alone pulls the transcript back down against every small scroll of the gesture. Sending a message scrolls to the bottom and re-enables following, so the sent turn and its reply stay in view even if the user had scrolled up. Only a scroll the user makes turns following off — a scroll the app makes itself, and any event the platform reports for one, never does. A send outranks the remembered position: a chat opened and typed into before its stream has settled stays at the sent turn rather than snapping back to where it was last left. Each chat's last scroll position is remembered per chat — reopening a chat the user had scrolled up in restores that position rather than jumping to the bottom. A chat opened at a message — from a search result — outranks both: that message is centred and briefly highlighted, and following is off. It is waited for while the transcript loads; if it never arrives (it is on another track), the chat opens as it otherwise would. On a touch device the soft keyboard opening must not scroll away whatever the user had on screen: the viewport meta sets `interactive-widget=resizes-content` so the browser shrinks the layout (and with it the stream's own height) instead of panning the page over the composer, and the stream reads that shrink the same way it reads any other height change — following re-pins to the newest message (matching `15-design-mobile.md` § Composer's `keyboardDidShow` re-pin), reading history leaves the scroll position untouched. A round down-arrow button floats at the transcript's bottom-right corner whenever the view is not following the newest message; clicking it scrolls to the latest message and resumes following, and it is absent while following (mobile has the same button, `15-design-mobile.md`).
- Messages — two-sided conversation. No `USER` / `ASSISTANT` caps labels: the transcript reads as a natural two-sided conversation (like iMessage). The user's turns render as a subtle leaf-tinted bubble (`--accent-tint` fill, `--accent-soft` border, softly-rounded with a flat bottom-right corner) offset to the right; the assistant's replies flow as clean text flush-left at the full reading measure — no bubble, no label. This matches the mobile app (green user bubble / bubble-less full-width assistant — `15-design-mobile.md` § Chat detail): neither surface boxes assistant prose in a bubble. Tool-call rows, permission cards and diffs stay left-aligned (assistant side). Messages are markdown rendered, code blocks syntax-highlighted. Rendering is `react-markdown` + `remark-gfm`, so GFM tables, strikethrough, task-lists and autolinks render properly. Tables get bordered styling and their own width rules (§ Wide tables). A fenced code block carries a copy control in its top-right corner, revealed on hover or keyboard focus and icon-only (§ Copy — no helper text); it puts the block's source — the code alone, no fence, no highlighting — on the clipboard, and the icon becomes a tick for a moment so the copy is confirmed where it happened. A clipboard write that fails says so on the control rather than looking like it worked. Inline code has no such control: it is a word in a sentence, and selecting it is the cheaper gesture.
- Long user messages collapse (accordion): a settled (non-streaming) user turn whose text is over 8 lines or 600 characters, whichever comes first, renders clamped to 6 lines with a bottom fade-out and a chevron toggle beneath the bubble — icon-only (▾ / ▴), no label, matching the pencil/track-switcher affordances' icon-only convention (spec/14 § no decorative text). Collapsed is the default, so a long paste doesn't dominate the transcript; clicking the chevron expands it in place. This is per-message React state, not persisted — it resets to collapsed the next time the chat is opened. A still-streaming turn is exempt (it's actively growing; clamping arriving text reads as broken, not tidy) and re-evaluates once it settles. Assistant replies are never clamped this way — they already render unboxed at the full reading measure, so a long reply is normal prose, not something to hide. This is a different mechanism from the tool-call disclosure above (`ToolDisclosure`): that pattern hides full detail behind a one-line SUMMARY of something else; here the message's own text is what's being clamped, so the collapsed state still shows real (truncated) content, not a stand-in.
- Message meta strip: each message can carry one quiet line of facts ABOUT the turn beneath it, hidden at rest and revealed on hover or keyboard focus of that message — the same reveal as the edit pencil, and permanently visible where there is no hover so it exists on touch. The transcript is for reading; metadata under every bubble is noise until it is asked for. At the strip's left edge, when known, is the real clock time this turn arrived (`HH:MM`), with the date prepended (`D MMM HH:MM`) when that turn wasn't today; it is absent for a message whose true time was never recorded rather than showing an invented one. A user message the agent took in mid-turn (`04-chats-and-folders.md` § Message queueing, delivery at a tool boundary) adds its position after the time: `after step N`, or `at the start`. On agent messages the chat's host and model follow the time; a message Tom typed carries neither, since they are the chat's current host and model rather than anything about that message. After it comes the retry marker: a turn the host had to re-send reads `Retried once` / `Retried twice` / `Retried N times` (`12-error-and-offline.md` § What a recovery leaves behind). A turn with no known time and no retry carries no strip at all.
- Attempt pager: a user turn the host re-sent folds every attempt into ONE bubble — a recovered turn is one turn, not one message per go. Where a superseded attempt has failed content, that bubble carries the SAME `< >` control as the track switcher (§ Branching), reading `< 2/3 >` — arrows and a count, no explanatory copy — and paging it walks the attempts. At rest it sits on the attempt that settled, so the transcript reads as the turn that worked; walking back shows what the attempt before it failed with. Where the retries left nothing to look at, there is no pager: arrows onto an empty page are a control that does nothing.
- Readable measure. The transcript content column is capped to a comfortable reading width (`max-width: 780px`) and centred in the panel, so lines keep a comfortable measure on a wide window. Prose holds that cap however much room the window offers; a table is the one exception (§ Wide tables). The header spans the full panel width. The composer's divider and background also span the full width, but its content (input + action row) is capped to the same 780px column and centred, so the input lines up with the message text rather than running edge-to-edge.
- Wide tables. A table is sized by its contents rather than by the measure, so it is the one block allowed out of the reading column. Every table sits centred on the chat. A table narrower than the measure keeps its natural width rather than being stretched to fill the room going spare, and sits in the middle of the column rather than flush against its left margin. Once a table's natural width passes the measure it grows evenly on both sides, into both gutters, as far as the panel's own edges, and scrolls horizontally only when even that is not enough — never rightwards only, which left a wide table hanging off the right of the text above it. Where the panel is narrower than the measure there is no spare room to take, and the table stays within the panel as any other block does. Cells wrap between words and never inside one: a cell that may break mid-word drops the table's minimum width to a couple of characters per column, so the table always fits, the scroll never engages, and a ten-column comparison renders as a tall stack of word fragments with half the window empty beside it. The table is always painted in full: the message box spans the gutters too (negative margin, matching padding), because the browser's off-screen skipping (`content-visibility: auto`) clips paint to that box and would otherwise cut the table's edges off.
- Breathing room. The transcript is read all day, so its vertical rhythm is specified rather than incidental:
  - Edge gutters — at least 32px above the first message and at the sides, 40px below the last, so no message touches the header rule or the composer.
  - Turn separation beats block separation — the gap between two turns (28px) is clearly larger than the gap between paragraphs within one. Assistant replies carry no bubble and no label, so if the two gaps are comparable consecutive turns read as one wall of text.
  - Prose leading — message body at 1.65.
  - Block spacing inside a message — paragraphs and lists at 0.6em, list items at 0.25em, markdown headings 0.75em above / 0.4em below. Tighter than browser defaults, so a reply doesn't read as if it's full of blank lines, but loose enough that a heading still reads as a section break.
  - List markers are visible — a `-`/`*` list renders with bullets and a `1.` list with numbers, sitting in the list's own indent. The CSS reset the app is built on strips the marker off every `ul`/`ol`, which silently flattened a model-written list into unlabelled lines, so the transcript restores the browser's own markers — including the depth-varying bullet on a nested list.
  - Bubble padding — the user's turn is padded 12px / 16px.
  - Tool-call rows get 10px of vertical separation, so a run of them reads as distinct rows.
  - Inside a turn, a tool row that meets prose — the reply text before or after it, or the working dots below it — sits 16px from it on BOTH sides, so it reads as a step between two paragraphs rather than hanging under one and crowding the next. The gap is measured from where the text ends: a message's timestamp strip hangs in the message's own 16px tail, out of flow, so having one (or not) never changes the gap.

- Goal bar (`/goal`): the chat's goal — set from the composer with `/goal <text>`, cleared with a bare `/goal` — sits in a bar above the transcript, below the header. Its text is editable in place: click it, edit, Enter saves and Escape reverts, so a goal can be corrected without retyping the command. A × clears it. No bar when the chat has no goal.
- Task bar (`02-daemon.md` § Task list): under the goal bar, the chat's task list reads as one line while collapsed — the item in progress (or the next pending one) and how much of the list is done, e.g. `Rebuild the index · 2/5`. Clicking expands the full list. All of it is editable, because the list is what the agent works from next: an item's status dot cycles pending → in progress → done, its text edits in place on the same click / Enter / Escape rules as the goal, × deletes it, and a trailing row adds one. Completed items read struck through. Edits apply optimistically and revert with an error toast if the host refuses them. No bar until the agent has written a task list.
- Goal bar (`04-chats-and-folders.md` § Goals): while the chat has an active goal, a bar sits above the transcript with the wake/reminder banners, below the header, reading the condition (truncated past ~80 chars, click to expand the full text), running time since it was set (live, `9m`-style), turns evaluated, tokens spent, and the evaluator's latest reason where one has landed yet (`Not met: <reason>`) — e.g. `◎ Ship the release by Friday · 12m · 3 turns · 8.2k tokens · Not met: tests still red`. An Edit affordance opens the SAME inline editor the old goal-only banner used (optimistic, reverting + toasting on failure, NO FALLBACK) and re-arms the evaluator on the new text as a fresh goal (fresh counters, same as typing a new `/goal`); a × clears it outright, with no verdict recorded. No bar when no goal is set, and it disappears the instant one resolves — replaced, once it has, by the finished-goal indicator in the chat header (below). The `◎` glyph is the same one the sidebar marker uses (§ Sidebar), so a reader learns to read it in one place and recognises it in the other.
- Finished goal, chat header: once a goal resolves (met/impossible) or is explicitly cleared, the header keeps a small `◎` with a muted label (`Goal met` / `Goal impossible` / `Goal cleared`) reachable for as long as `lastGoal` names it — clicking expands condition, duration, turns, tokens, outcome and the evaluator's final reason. Replaced the moment a NEW goal starts (back to the bar above), not merged with it.
- Wake bar (`02-daemon.md` § Self-wake): when the chat has a pending self-wake, a bar sits above the transcript (with the goal / reminder banners, below the header) reading how long until the wake fires and the wake message — e.g. `Wakes in 9m · check whether the bus has left`. The countdown is live (re-rendered every second) and switches to a bare `Wakes now` once `fireAt` has passed but the turn hasn't landed yet. No bar when nothing is armed, and it disappears the moment the wake fires or is cancelled. A plain one-shot wake (armed by `patch_wake_me`) is read-only there — the agent owns its own timer; there is no × to cancel it. A RECURRING wake (`pendingWake.every` set — armed by `patch_loop` or a user's own `/loop`) reads `Loops every 5m · next in 3m · check on the build` instead, and carries a × that stops it via the same `chat.loop_request`/`patch_cancel_wake` path either side would use — unlike the plain wake, a loop is exactly as likely to have been started by the user as by the agent, so it stays stoppable from wherever it's seen.
- Background task bar (`02-daemon.md` § Background task completions): a background command or sub-agent keeps running after the turn that launched it ends, so a chat can sit idle with work still in flight. When this chat has one or more still-running background tasks, a stack of bars sits under the wake bar above the transcript: ONE BAR PER TASK, newest first, each reading its own task's description — e.g. `Build web package to compile CSS` — and each carrying a spinner that actually turns, since a frozen glyph reads as work that has stalled rather than work in flight. The spinner is a smooth ring rather than a spoked wheel and turns at a rate a reader can follow: a many-spoked glyph spun fast strobes, and a strobing marker draws the eye off the transcript it sits above. Its rotation is even end to end, since an eased loop pulses once per turn, which is the flicker again by another route. Each bar also reads what its task is costing the machine — CPU and resident memory, e.g. `98% · 412 MB` — set at the row's trailing edge, muted, and refreshed every few seconds for as long as the bar is on screen (`02-daemon.md` § Background task completions). A task the host cannot measure shows no figures at all rather than zeroes or a dash. The bars are sized for that: a row carries a description, a spinner and two live numbers, so it is set at the same size as body text on a line tall enough to read at a glance rather than the tightest line that fits. One bar per task and not a count plus the newest description, because the newest is rarely the one being waited on: three tasks in flight showed one line, named the last one launched, and silently hid the other two. The stack is titled by its own count (`3 background tasks`), drawn like a collapsed project's row count in the sidebar, and that title stands above the bars whether the stack is open or closed — how much is running is the one fact worth having without reading a list, and it must not be the thing that disappears when the list appears. The stack collapses — a chevron at its trailing edge folds every bar away, leaving the title alone with a spinner of its own, and the same chevron opens it again. Expanded is the default: the stack only exists while something is running, and seeing what is running is the whole point. Collapse is a per-user display preference rather than per-chat state — it persists across reloads for that browser and applies to whichever chat is open, like the rest of the layout state (## Layout). The spinners sit still under a reduced-motion preference. Each task's bar is a button. Clicking it opens this chat's Terminal tab (§ Panes and tabs, § Terminal) and follows that task's live output there — the agent layer is already writing it to a file on the same host the shell runs on (`02-daemon.md` § Background task completions), so what the task is doing is read from that file rather than invented. The command is entered as if typed at the prompt, so it is echoed into the scrollback and joins that session's command history, and interrupting the follow is the terminal's ordinary `Ctrl-C`. A task whose launch has not yet reported a background id names no file, so the terminal still opens and says exactly that: an id is not guessed, nor a lookup run that cannot match. The title names no single task, so it opens nothing. The bar offers no way to kill or edit a task: the agent owns it, and the launching call is already in the transcript. No bar when none of this chat's tasks are running. It speaks only for this chat — other chats' background runs are the sidebar's Automations section (§ Sidebar §6). A task is running from the tool call that launched it in the background until it ends. A completion notice that still carries its raw block is paired with its launch by the tool call id the block names; one the host has already lifted to its summary sentence carries no id at all, so it is paired by the description the agent gave the task, and where two live tasks share a description the completion closes the oldest, so N launches and M completions leave N−M running. A task the agent explicitly kills ends too, paired by the background id the launch's own result reported. Completed, failed, stopped and killed are all ends: a task that has ended is never counted in the title and never spins, whatever its outcome. An unreadable notice ends nothing — it is not attributed to a task by guesswork. A checkbox on the title row, reading Show all, additionally lists this chat's ended tasks under the running ones, newest first: struck through, with no spinner and no cost figures, since a finished task is neither turning nor holding processes. It adds to the bar rather than creating one, so a chat with nothing running still shows nothing. The title's count stays the number running. An ended task's bar opens the terminal the same way — the agent layer leaves the output file behind when the task exits, so what it did is still there to read. Like the collapse, the checkbox is a per-user display preference that persists across reloads.
- Artifact bar (§ Artifacts): when this chat has published one or more artifacts, a bar sits under the background task bar above the transcript: one chip per artifact, newest first, each reading the artifact's title. Clicking a chip opens that artifact exactly as clicking its transcript card would (§ Artifacts — "In the chat"). It exists because the transcript already holds a card per artifact, but an EARLIER one means scrolling back to find it; the bar is the standing index so any artifact the chat has ever published stays one click away without touching the panel's own single remembered URL (`artifactPanel.ts`) or the transcript's scroll position. Republishing the same file (same `artifactId`) updates its existing chip in place — same identity rule as the card — rather than adding a second one. No bar when the chat has published nothing.
- Delegate tool row: a `patch_delegate` call renders as an ordinary tool-call row (§ Tool calls) with one addition — a live state pill (`Running` / `Awaiting permission` / `Done` / `Failed` / `Stopped`) that updates in place from the `chat.delegate_update` events the host emits on THIS chat for that subagent (`02-daemon.md` § Native subagent dispatch), and is a collapsible row, collapsed by default, like a Claude Code Task. The subagent is never a chat this surface can open the ordinary way — it is nowhere in the sidebar, Hidden, Archived or search (`04-chats-and-folders.md`) — so this row is the only door into it: expanding the row fetches `GET /api/chats/:parentChatId/delegates/:id/history` and renders the exchange inline beneath the row, inside the parent transcript (no dialog, no composer, no tool calls, no permission cards — a transcript, not a second chat window), the same shape `patch_history` returns for any other chat. The subagent's own `patch_delegate_stop` never comes from this row — that is a decision for the agent, not a click the user has — but a question the subagent asked mid-task does not wait in that row: it is mirrored onto THIS chat's own transcript as an ordinary permission card, labelled with the subagent's name, and answering it there is what unblocks the subagent (same section). The row's state stays `Running`/`Awaiting permission` until the host's `[from <label>]` delivery lands as the next message, at which point the pill settles to `Done`/`Failed` and stays there on replay.
- Background workers pill: the chat panel header shows a count pill (`1 worker` / `N workers`, label list in its tooltip) beside the title while any `patch_delegate` subagent of this chat is `Running` or `Awaiting permission`; absent with none running. It is the header-level echo of the Running delegates strip below.
- Running delegates strip: while any `patch_delegate` subagent of this chat is `Running` or `Awaiting permission`, a persistent strip sits directly above the composer with one line per subagent — its label and how long it has been running (counted from when this surface first saw it, ticking each second). It exists because the Delegate tool row scrolls away with the transcript. Each line opens that subagent's read-only transcript inline beneath it (same history endpoint and shape as the Delegate tool row). A subagent leaves the strip when its state settles to `Done`/`Failed`/`Stopped`; with none running the strip is absent.
- "Thinking…" indicator: while a chat is `running`, an animated three-dot typing indicator sits at the foot of the live transcript, below every message and above any queued turns (`04-chats-and-folders.md` ## Message queueing). All three dots share one beat, pulsing together rather than travelling in sequence, and the pulse is opacity alone — three dots hopping on the same beat reads as the row itself jumping. It covers both the gap between send and the first reply token and the pauses BETWEEN messages mid-turn (extended thinking, tool calls), so a running chat never looks dead. It hides only while an assistant message is actively streaming, where that message's caret already shows progress — a settled assistant message with the turn still running keeps it. It also shows while a composer attachment is uploading, since the turn does not exist until the upload finishes.
- Empty state: a brand-new or message-less chat shows the on-brand illustration (the patch chat-bubble mark with a small leaf sprout) over a single warm title (New chat / No messages yet) — no hint line. The graphic is centred both vertically and horizontally in the chat panel — the stream is a flex column and the empty-state fills it so it sits dead-centre.
- Tool calls: collapsed by default with one-line summary; click to expand full args + result. The summary is a plain-language "Doing x" sentence with no tool id in it (never `Bash …`): the call's own description where the tool supplies one (`List open PRs`), otherwise a phrase built from the thing it acted on — `Reading poll.ts`, `Editing poll.ts`, `Searching for "timeout"`, `Running "pnpm test"`, `Fetching <address>`, `Running the Explore agent`, `Using the plant skill`. A tool that offers nothing to name still says what it is doing (`Reading a file`, `Running a command`). Tool rows are set in the body font, not code; only the expanded args and results are monospace. A file is named by its filename, not its absolute path: the row is one line that truncates at its end, and every path under a chat's folder opens with the same long identical prefix, so drawing the whole path spends the row on the part that reads the same on every row and cuts off the only part that differs. The full path is in the expanded args. Every `patch_notify` call renders as a green box holding its message and importance, so the transcript shows when the chat fired a notification; a `deepLink` is a tappable row inside that box — not buried in the expanded JSON — since the point is one click, not disclosure-then-click (`09-notifications.md` § `### push`). A mutating `patch_job_*` call (create/update/delete/enable/disable) gets the same treatment for the same reason: it changes what runs on a SCHEDULE, so its effect outlives the turn and cannot be re-read from the transcript. Its row announces the change rather than collapsing into the one-liner an `ls` gets — the past-tense verb (`Job created`), the job's name, its schedule rendered by the SAME derivation the Jobs list uses (`08-triggers-and-jobs.md` § Cron), and an always-visible link to the job. The id comes from the result where there is one and from the call's own args otherwise, so a call whose result is unusable still announces itself and is still followable — a job created with nothing at all on screen is the failure this row exists to prevent. Read-only job calls (`patch_job_list`, `patch_job_runs`, `patch_job_webhooks`) change nothing and stay on the ordinary collapsed row. A tool result's summary always says what its call was doing (e.g. `Reading poll.ts →`), never the bare word "tool" — a replayed chat resolves a result's name from the matching call earlier in the same transcript (correlated by call id), since the persisted result itself carries no name.
- A call and its own result are ONE row, not two. A lone tool call whose result is the very next entry (correlated by call id) renders as a single disclosure: the call's summary, suffixed `→` to say it has returned, expanding to the args it was made with and what came back, separated. A call still running renders alone until its result arrives; a result whose call id does not match the entry above it keeps its own row, so an interleaved run can never fold the wrong result into a call. This is the ungrouped counterpart of the run-collapsing rule below — in both cases one thing that happened reads as one line.
- Expanded args/results render as `key: value` rows, one per field, nested objects indenting into their own list. An ARRAY's elements stack unlabelled: positions are not field names, and labelling them prints a literal `0:` above every element — most visibly under a `Read` image result, whose payload is the two-element content array `[text, image]`.
- Tool runs: a consecutive run of more than one tool call collapses into a single row standing in for the whole run, rather than a row per call and another per result. That row says what the batch was FOR, the way a progress log would — e.g. `Set up the project locally`, `Searched the web for Haiku pricing`. When a run closes (at the next message, at a call that keeps its own row, or at the end of the turn), the host asks a small model (Haiku, on the same account gate as chat titles and status) for that line from the calls and the prose around them, and stamps it into the stream as `chat.tool_run_summary`, keyed by the run's call ids; it persists and replays with the transcript. Which calls may fold into a run is one rule shared by the host, web and mobile (`@patch/wire`'s `isGroupableToolCall`), so the run the host labels is the run a surface draws. Until the label arrives — while the run is still live — the row reads the agent's own sentence just before the run (first line, clipped to 80 characters), e.g. `Researching how to set up shaver…`, the way Claude Code's status line does; no model call is made for it. Only when the run has no such sentence does the row count the work by kind in the order it first happened, e.g. `Ran 3 commands, read 2 files, searched for 1 pattern`. If generation fails, the row keeps that count and shows a warning mark whose tooltip gives the reason, rather than passing the count off as the summary. The label describes what happened, not what was attempted: the host hands the model each call's outcome, a failed call is marked as failed with a clip of its error, and the label says the batch _tried_ to do the thing rather than claiming a failed call succeeded. A label is only shown on the run whose call ids it names. Never the individual calls' targets on the collapsed row — that detail isn't needed unless the row is opened. It is collapsed by default. It is set in the body font rather than the monospace code font the rest of a tool row uses, since it's a description, not code. Expanding it mounts exactly the rows it replaced, each in the ordinary tool-call presentation (§ Tool calls above) — detail included. File-edit and `Monitor` calls stay directly in the transcript with their own rows, since each carries an affordance of its own (§ Diffs, § Monitors (historical)).
- Image content in expanded tool args/results: an image content block (`{ type: 'image', source: { type: 'base64', media_type, data } }`, e.g. from `Read` loading a screenshot) renders as an actual inline `<img>` (same click-to-zoom lightbox as a message attachment), not as a dumped base64 string — the expanded detail pane is for inspecting the tool's work, and a wall of base64 text serves that worse than the image itself. It renders at the detail pane's full width, capped at 70% of the viewport height: an image is there to be looked at, and a thumbnail small enough to need the lightbox before it can be read defeats the point of showing it inline.
- Context compression (`02-daemon.md` § Context compression): one quiet line in the stream reading the compression and the tokens either side — e.g. `Context compressed · 156k → 42k`. It is transcript furniture, not a message: no bubble, no role header, set small and muted so a long chat's compressions recede. It uses the same disclosure as a tool call — click to expand the exact before and after counts, whether it was automatic or manual, and how long it took. Counts the SDK didn't report are simply absent from both lines.
- Permission-mode change (`02-daemon.md` § Permission mode): where the mode was changed part-way through the conversation, the stream draws one hairline rule with the mode named on it — e.g. `Permission mode → acceptEdits`, using the agent's own word for the mode as every control offering the choice does (§ Composer). It is transcript furniture like a compression line — small, muted, no bubble and no role header — but a divider rather than a disclosure: the line is the whole fact and there is nothing behind it to open. Where Claude Code made the change itself rather than a person using the mode control (the plan-mode exception, `02-daemon.md` § Permission mode), the same line says so instead of reading as though the mode control had been used.
- Job trigger turn (`08-triggers-and-jobs.md` § Action): a user-role turn that a job put into the chat — the `spawn` action's own first prompt/payload, or any later `continue`/`message` fire into an existing chat — is not something the user typed, whichever turn of the chat it lands on. It renders as transcript furniture (`Automated trigger`), same quiet-line-with-disclosure treatment as context compression, rather than a user bubble; expanding shows the exact prompt/payload text. A turn the user actually sent into that same chat (replying in a persistent `continue` chat, say) keeps the ordinary bubble.
- Background task completions (`02-daemon.md` § Background task completions): a finished background command or sub-agent is its own quiet row — a badge carrying Claude's mark, the task's description, and its kind, status and exit code where it has one. The badge is what says the row came from the agent layer underneath rather than being something Patch said. A system message that is not a completion notice renders as an ordinary message. Where the completion arrives as a user turn still carrying its raw `<task-notification>` block (`02-daemon.md` § Background task completions — replay, and hosts running an older host), it never renders as a user bubble: it reads as the same badge and one line of summary, transcript furniture with the same quiet-line-with-disclosure treatment as a job trigger, and expanding shows the raw block. The line is the block's own summary sentence where it has one; a block with none reads as `Background task` — no sentence is invented for it, the raw block is a chevron away.
- System-reminder disclosure (`02-daemon.md` § System-reminder disclosure): a turn that carried one or more captured `<system-reminder>` blocks — a daemon-restart notice, a rewritten task list, a broadcast digest — gets a small disclosure sitting under that turn's own bubble, labelled with what the block was (e.g. `Turn interrupted by restart`, `Broadcast digest`); same quiet, collapsed-by-default "click to expand" treatment as context compression, but a sibling of the message rather than a replacement for it — the turn itself still renders normally, this just says what else it saw. Collapsed always by default: this is for checking what a reply actually reacted to when something looks off, not something read on every turn. More than one captured block on the same turn draws one disclosure per block, in the order they were injected.
- Provider-level context panel (`02-daemon.md` § Provider-level context): Claude Code's OWN provider-level context — environment, model identity, token counts, and the rest of its `type: "attachment"` entries — is chat-scoped rather than turn-scoped (unlike the system-reminder disclosure above), so it does not sit under any one bubble: `ProviderContextPanel` draws with the chat's other standing banners (Goal, Reminder, ...) above the transcript, one collapsed row per category rather than per message. A category that recurs — a token-count reminder can fire hundreds of times in a session — updates its ONE row in place and names how many times it has recurred (e.g. `Tokens remaining ×203`) instead of drawing a row per occurrence. Rows keep the position they first appeared in as they update, so the panel's order never reshuffles under a live chat. Same quiet, no-colour treatment as the system-reminder disclosure; absent entirely on a chat that has received none. Default expand state (collapsed vs. hidden vs. expanded) is the account-wide `providerContextVerbosity` Settings preference below, not fixed — a per-row click always still overrides it locally.
- Diffs: inline unified diff view for file-edit tools (read-only preview from the stream), collapsed by default behind its own chevron — same "collapsed until asked for" default as any other tool call. Clicking the file-edit summary line still opens the file's own tab, showing the diff (§ Diff editor); the chevron is a separate control that only toggles the inline preview.
- Permission prompts: Approve / Deny buttons inline. The card is a solid block of the waiting tint (§ Palette) the full width of the transcript column — an approval halts the turn until it is answered, and it is the one state in the transcript that gets colour rather than structure. A request is identified by its request id, and one request draws exactly one card however many times it arrives. A replay re-sends every still-pending permission on the chat regardless of the replay cursor (`12-error-and-offline.md` § Replay vs history cursors), so a card already on screen is re-delivered on any later replay — on reconnect, or on re-opening a chat left paused on an approval. A request already held is ignored, both in the transcript and in the chat's set of pending permissions; a second copy in that set would also inflate the waiting state and make approve-all answer the same request twice. Two distinct requests still draw two cards — a turn can pause on several approvals at once, which is what approve-all is for. That sweep is offered as **Approve all outstanding**, and only on a card whose chat has more than one request outstanding at that moment: on the ordinary single-approval card the control does exactly what Approve does, and its name invites the wrong reading — that it is a mode which keeps approving whatever arrives next — so it is not drawn at all. It is named for what it does: a one-off sweep of the requests outstanding when it is clicked, this chat only, nothing persisted and nothing pre-approved. The `2` chord stays live either way (§ Keyboard shortcuts); with one request outstanding it simply approves that one. One request appearing in both the inline card and its file's own tab (§ Diffs) is a different thing and is intended. An answered request is no longer a prompt: its card drops the options and reads the outcome (Approved / Denied) in the quiet transcript-furniture treatment, so the same request cannot be answered twice. The card is marked answered however the answer arrived — this surface's own tap, or `chat.permission_response` reporting an answer given elsewhere, including the spoken yes/no of a voice session (`07-voice-app.md` § Permission prompts during voice). The chat's waiting state clears once no other request is outstanding; the activity itself settles on the host's own `chat.state`.
- Question prompts (`AskUserQuestion` — `02-daemon.md` § Questions are not approvals): the agent asking the user to choose is NOT an approval, and must not render as one. An Approve/Deny card here is actively wrong twice over — it shows the tool's name instead of the question, and approving returns no answer at all, so the agent carries on having "asked" and heard nothing. The card instead renders what was asked: per question, its `header` as a small chip, the question text, and its `options` as selectable rows — each option's `label` with its `description` beneath, so the trade-off the agent wrote is on screen at the moment of choosing. A question that will expire (`02-daemon.md` § Questions are not approvals) also carries a countdown: a ring in the card's top corner that depletes as its window runs down, counted against the deadline the request carries rather than against a timer the surface started when it drew the card, so a surface opened late shows the time actually left. It is named for a screen reader with the seconds remaining, and at zero it reads as expired and stops moving. Reaching zero does not resolve the card — only the host's resolution does, and until that lands the card stays answerable. A question carrying no deadline shows no ring. It does not carry the approval card's fill either. A question is a form to work through rather than a single yes/no, so it is drawn with structure instead of colour: an outlined panel on the panel surface, the waiting tint reduced to the card's own border and its `header` chips, and each option an outlined row on the elevated surface so the rows read as the controls they are against the card behind them. A selected row is ringed in the accent; the answered card drops the amber border for the plain rule and fades, so answered and unanswered never look alike. A request whose arguments are not the tool's documented shape is never downgraded to an approve/deny — approving one would be the answerless approval this card exists to prevent — so the card says the question could not be read, offers Cancel as the only way out, and is outlined in the danger colour instead of the waiting tint. `multiSelect: false` questions are radio-like (picking one clears the other); `multiSelect: true` questions toggle independently. `Other` follows the question's mode: on a single-select question it is one more radio (choosing it deselects the picked option, choosing an option deselects it), its text is an optional comment, and `Other` with no comment is a complete answer that sends the label `Other`; on a `multiSelect` question it toggles independently, and its typed text is sent after the picked options (`Search, also Temporal`) and is required for it to count as an answer. Which of the two a question is must be legible without reading anything: every option carries a leading selection indicator, a circle where one answer is wanted (`Other` included) and a square where several are, filled with a dot or a tick respectively once chosen. Drawn alike, the two modes are told apart only by what a second click happens to do, so the first pick becomes the whole answer to a question that wanted more than one — and only a screen reader, which is given the option's role, is ever told otherwise. The indicator is decoration: the selected state lives on the option's own role and checked-ness and is never repeated into its accessible name. Every question also carries the free-text `Other` escape hatch Claude Code always offers — the agent's options are its guesses, and the answer is often none of them. Choosing `Other` puts the cursor in the box, so the click that reveals it is the click that starts typing. The `Other` box is a multi-line field, and its Enter mapping is the deliberate INVERSE of the composer's (§ Composer): `↵` and `⇧↵` both insert a newline, and `⌘↵` / `Ctrl↵` send. A free-text answer to a question the agent asked is the long-form case — paragraphs are normal and a stray `↵` sending half of one is the expensive mistake — so the cheap key is the newline, not the send. It sizes itself to what has been typed (one row until there is a second), never shows a drag handle, and scrolls internally past a cap rather than pushing the card's own buttons off-screen. `⌘↵` is guarded on exactly the same completeness as the Send answer button, so the shortcut cannot send a card the button is disabled from sending. Because that mapping is the opposite of the one every other field in the app uses, the Send answer button names the chord that sends — `⌘↵` on a Mac keyboard, `Ctrl↵` on any other — drawn quietly on the control itself rather than as a line of explanatory copy, and said in words in the button's accessible name rather than as glyphs. The platform read is the one at the keyboard, the surface the card is drawn on, never the host the agent happens to run on: the two are routinely different machines, and a Windows keyboard told to press `⌘` has no such key. Where the keyboard's platform cannot be told the button reads `Ctrl↵`; it is never left blank or ambiguous. The card is answerable without the mouse: each question is one Tab stop, so Tab and Shift-Tab step question-to-question (and on to Send answer and Cancel) rather than through every option of every question, while the arrow keys move within the focused question's own options — up/down or left/right, wrapping at both ends, Home/End to the first/last. Moving the cursor does not choose: `Other` is one of the options the arrows land on, and choosing it opens the free-text box and takes the cursor, so a card that selected as it moved would end the journey the first time it passed over `Other`. `↵` or Space chooses the option the cursor is on (toggling it, in a `multiSelect` question), and the cursor's position is drawn distinctly from a selected option so the two are never confused. An unanswered card takes the cursor when it appears, landing on the first question's first option so the arrows work without a Tab first. Submit is disabled until every question has an answer (a partial submission would send the same empty answer this card exists to prevent), and returns the selections through `approve_with_edits` (`03-wire-protocol.md` § Answering with content). Cancel is a real deny: the tool does not run and the agent is told so. Because the card is a question, `1`/`2`/`3` and Approve all outstanding do not apply to it — approve-all sweeps past it rather than answering it blankly, since there is no answer a blanket approval could honestly give. The card IS the tool's row: once it has rendered, that call's generic tool-call row is suppressed, and so is its tool-result row where the card was ANSWERED — the card already shows the questions, the options, the selections and the outcome, and repeating them tells one event three times. A card that was NOT answered keeps its result row: a user cancel and a question that expired unanswered (`02-daemon.md` § Questions are not approvals) are both a plain `deny` on the wire, so the card can only say `Cancelled` and the tool result is the only place the reason appears. Suppression is conditional on the card really being in the transcript at a lower seq — a question that produced no permission request still shows its tool rows, since losing the only trace of a tool run is worse than showing it twice.
- Retry / copy / inspect raw event — message context menu on long-press / right-click.
- Composer: text input (1 row by default), `⎇` (option) to open editor for the file the agent most recently touched. `↵` (or `⌘↵`) sends, which mid-turn queues and never interrupts; `⇧↵` inserts a newline. The input is white with a focus ring so it reads as a field against the warm panel. IME composition is respected — Enter commits the candidate rather than sending. The field grows with what is typed, and it grows UPWARD: the space comes out of the transcript above, so the input's own bottom edge and the action row beneath it never move and nothing is pushed off the bottom of the window. It shrinks back the same way when text is deleted, and shows no scrollbar at all while it is growing. It stops at a cap of roughly eight lines and scrolls internally past that, so a long paste takes a readable amount of the screen rather than all of it. There is no drag handle — the field sizes itself. The layout is stacked: the text field spans the full chat width on its own row, and the action buttons sit on a row below it — the utility buttons (attachment, dictate, call) grouped on the left, side by side at the same icon size, send pushed to the far right. Call moved here from the chat header (§ Chat panel header) — it reads as the same family of composer-adjacent action as attach and dictate, rather than a tenth icon in the header's own rail. On a not-yet-spawned chat, pressing Call creates the chat first (the same create-then-act path an attachment with no chat yet already uses), then calls the real id. Every action button shares ONE icon size (18) — no glyph reads bigger or higher than its neighbours. Unsent composer text belongs to the chat it was typed in, and the SERVER owns it — one draft per chat, kept regardless of whether the chat's host is even awake — so it follows the chat onto every surface that has it open, not just the one it was typed on. Leave that chat (a sidebar row click, archiving the open chat, or any other route change) and it stays with it; come back — on this surface or any other — and it is in the composer exactly as it was left, surviving a reload. It is never carried into another chat: every chat shows its own text or none. Typing saves to the server shortly after a pause (debounced), and the update reaches every other open surface showing that chat live. A surface whose composer has focus is never overwritten under the cursor by an incoming update from elsewhere; it takes the newer text only once the composer loses focus or the chat is reopened — newest write wins otherwise. Sending clears it everywhere; a send that fails keeps it for a retry. Deleting the chat drops it; archiving does not. Emptying the composer drops it too — what is remembered is what is there to send, so typing something and then deleting it again leaves the chat exactly as it was found, and text that is only whitespace is empty for this purpose. Offline, the surface keeps what is typed locally and pushes it to the server once reconnected; if a save to the server fails outright the surface says so rather than letting the words go quietly. This is distinct from new-chat drafts (§ New chat drafts), which are whole not-yet-spawned chats with a folder of their own. The text in a not-yet-spawned chat's composer is a new-chat draft, never a composer draft: no surface sends the new-chat placeholder key as a composer draft, the server refuses to store one (and drops any it finds on disk), and a surface ignores one it is told about — so what was typed into a new chat on one surface is never injected into the next new chat on another. Opening a chat puts the cursor in the composer — every way in (a sidebar row click, a keyboard chat switch, the auto-advance after archiving, a direct URL load), not only the first one of a session — so typing is what you do next without clicking first. It is a courtesy, not a claim: the cursor is taken only when nothing else already owns it, so a permission or question card that has taken the cursor for its own keys, an open modal, and any field being typed into all keep it. While the connection is down the composer reads Reconnecting… and takes nothing, and a later reconnect does not pull the cursor back out of wherever it has since moved.
- Message hooks (`20-hooks.md` § Checking a user_message, § On the user's message): sending first calls `POST /api/hooks/check`. While it is in flight the send button's idle state is replaced by a disabled **Checking…** control, so a wait is never a silent one — which hooks matched is not known until the response lands. A `pass` result sends as normal, nothing shown. An `advise` result sends as normal and attaches a small note to the sent message on THIS surface, naming the advising hook(s), expandable to each one's analysis — this is this-surface, this-session state (spec/20-hooks.md § Never reaches the agent), not part of the persisted transcript, so it is gone after a reload and is not shown on another surface. A `block` result keeps the text in the composer and opens a card above it, docked the same way the permission/question cards are: the blocking hook's name, its analysis, and its suggestion when it gave one, with **Use suggestion** (replaces the composer text, does not send), **Edit** (closes the card, composer untouched) and **Send anyway** (sends the original text, skipping only the hook(s) that blocked this one send). More than one blocking hook stacks on the card; Send anyway clears all of them for this send. A hook that failed or timed out renders on the card with its error in place of an analysis, and offers only Send / Edit — never a suggestion it never produced, and never silently treated as a pass.
- Agent-response hooks (`20-hooks.md` § On the agent's response): run after a turn settles, on the agent's side, quietly — no Checking… state, no card, nothing on the composer, since there is no send waiting on it. A `pass` shows nothing. A `block` resubmit arrives as an ordinary user turn tagged `hookTrigger` and renders exactly like a job trigger turn (§ Job trigger turn above) — one quiet furniture line, collapsed by default, except its summary names the blocking hook(s) ("Hook blocked — no secrets") instead of reading "Automated trigger"; expanding it shows the hook's analysis/suggestion verbatim, because that text IS the turn's own content (spec/20-hooks.md: "no invisible injection") rather than something parsed out of a separate field. An `advise` outcome, or a hook that failed or timed out, creates no turn of its own: the note (the analysis, or the error) rides as a `systemContext` disclosure (§ System-reminder disclosure) under whichever turn the chat runs next, labelled "Hook advice" or "Hook failed" — the same collapsed, click-to-expand treatment as any other captured reminder, surfacing only once that next turn actually lands; never resubmitted, since a broken hook has nothing to redo. Neither carries a badge or a notification: a `block` resubmit runs with `origin: 'machine'`, which is exactly the signal that already keeps a self-wake or the todo auto-advance off the completion doorbell (`09-notifications.md`) — a hook intervening is not news on its own, only whatever the chat's own activity produces is.
- Goal verdicts (`04-chats-and-folders.md` § Goals): the SAME quiet-furniture treatment as a hook's `block`, since a goal `not_met` resubmit IS one — an ordinary user turn tagged `goalTrigger` instead of `hookTrigger`, collapsed by default, its summary `Goal not met — <reason, truncated>`; expanding shows the evaluator's full reason, which IS the turn's content, verbatim. A `met` or `impossible` outcome creates no turn to resubmit — the host marks it with a plain system-role row instead, collapsed the same way (`Goal met` / `Goal impossible`, expand for the full reason); `met` rides the chat's ordinary next completion doorbell exactly as any settled turn does, `impossible` additionally raises the chat as needing attention (`declaredStatus`), same as the hook loop guard. A `refused` verdict is resubmitted like `not_met` and reads the same (`Goal not met — <reason>`). The deadlock guard tripping is NOT a verdict and draws no row of its own — it surfaces through `declaredStatus` alone, same path, so the chat's status line (not the transcript) is where "deadlocked" is read.
- Approval mode: a dropdown in the composer's action row, under the text input, carrying the mode this chat's next turn will use (`00-overview.md` § Permission model). It sits with the composer because it governs the turn about to be sent. It follows the utility buttons — attach, dictate, call, then the dropdown — with stop and send still pinned to the right of the row. Its options are the five modes named exactly as `02-daemon.md` § Permission mode names them (`auto`, `default`, `acceptEdits`, `bypassPermissions`, `plan`): the value goes straight to the agent, so the control shows the agent's own word for it rather than a friendlier one Patch made up. Picking one sets this chat's mode (`chat.settings`); there is no option that clears it, because a chat always has a mode of its own. It is styled as a quiet peer of the action icons, not a control competing with send, and it is always there on an existing chat, including before the host has reported a mode (it then reads `Approval mode` and offers every mode) — only the new-chat screen omits it, because its setup row owns the choice. The model pill beside it likewise stays on the row when no model has been reported, reading empty rather than a guess.
- Skill autocomplete: typing `/` opens a dropdown of the skills discoverable from the chat's folder on its host (`GET /api/skills?daemonId=&folder=`), filtered as you type (`/pl` → `plant`, `plan-travel`), anywhere in the message it begins a word — the start of the message, or right after whitespace or a newline — not only when the composer holds nothing else. The menu is active only while the token AT THE CURSOR is still open (no closing space yet); moving the cursor into a different word, or closing the current one with a space, closes it. ↑/↓ move the highlight, Enter or Tab completes the highlighted skill (splicing `/<skill> ` in at that token, with a trailing space, leaving the rest of the message untouched; Tab does not move focus out of the composer), Esc dismisses without clearing the text, clicking anywhere outside the dropdown dismisses it the same way (§ Dismissing pop-ups (click-off) — the typed `/token` stays in the composer), and clicking a row completes it. A fetch error surfaces in the dropdown, and so does an empty result — a folder with no skills, or a prefix matching none, says so. The dropdown opens once the list has loaded, so `/` reports the real result rather than a mid-fetch "no skills". The list is re-read from the host every time the menu opens, so a skill added, renamed or removed on the host is there on the next `/` without a reload; typing to filter re-uses the list the open started with, and a re-open keeps the previous list on screen until the new one arrives so it never blinks empty. With nothing to complete, `↵` sends the message. The list defaults to the last-used skill: completing a skill remembers it per chat folder (persisted locally), and on the next `/` that skill is sorted to the top of the list and highlighted, so `/` + `Enter` re-runs it. This is ordering only — the fetched set and the typed prefix filter are unchanged, so a last-used skill that no longer matches what you've typed (or has been removed from the folder) simply doesn't appear and the list keeps its natural order. Each folder remembers its own last skill; a folder with no completed skill yet shows the list unreordered. The dropdown also carries built-in commands, which exist in every chat regardless of folder — currently `/clear` (clears the visible transcript; the history stays on the host) and `/goal` (sets the chat's goal from the text after it; bare `/goal` clears it). Built-ins are listed above the folder's skills, but they do NOT displace the last-used skill: it still sorts to the very top and stays the highlighted default, so `/` + `Enter` re-runs it rather than firing a built-in. In a folder with no last-used skill there is nothing to outrank and the built-ins lead. Each row also shows the skill's frontmatter `description:` on a second, muted line, trimmed to two lines; a skill with no description shows just its name, with no filler text. The highlighted row gets a preview panel beside the list: the full description, the rest of the frontmatter (every field beyond `name`/`description` — `user-invocable`, `allowed-tools`, anything else the file declares), and an Edit link to the skill's own file, using the same `resolveSkillLink` containment rule the Jobs view's Skill field uses (§ Jobs view) — no chat on that folder, or a machine-wide skill outside it, drops the link rather than offering one that would 404. A skill with no frontmatter at all shows no preview beyond its name and the Edit link. A built-in command's one-line description is declared in code, not read from frontmatter; its panel is that description alone, with no fields and no Edit link, since it has no file.

- Skill chips: once a `/<skill>` token is complete — closed by the menu (which always appends the trailing space) or by typing the exact name and then a space by hand — it renders as a small box in the composer text instead of plain characters, wherever in the message it falls. Hovering a chip shows the same preview the `/` list's highlighted row shows: full description, the rest of the frontmatter, an Edit link. Backspace with the cursor right after a chip removes the whole `/<skill> ` in one press rather than eating it one character at a time; anywhere else Backspace behaves as it always has. Copy and paste carry the chip as its underlying `/<skill>` text, since a chip is compose-time rendering only, never a distinct stored value — a pasted `/<skill> ` becomes a chip the same way one that was typed does. What is sent to the agent is the literal text, unchanged, chip or not, in the same position it was typed — a chip never rewrites the message. That matters because only a `/` at the very start of the WHOLE message is a command invocation Claude Code itself recognises and acts on; a `/<skill>` chip elsewhere in the message is still just text to it, read (or not) exactly as any other word would be. The composer draft (§ Composer, above) stores this same plain text, so a chip already in a draft renders as one immediately on reopening the chat, without needing `/` typed again.
- Attachments (shared behaviour — see `15-design-mobile.md` § Composer for the cross-surface contract): on web/desktop there is a single attach button (paperclip) — one OS file dialog that accepts images and any file. A screenshot-grab button (only when the shell supports `navigator.mediaDevices.getDisplayMedia`) captures a screen/window, grabs one frame to a canvas, and attaches it as a PNG through the same resize path. On macOS the capture fails with `NotReadableError` / "Could not start video source" until Patch has been granted Screen Recording permission — a one-time OS grant the app can't do for the user, so instead of surfacing the raw error the composer shows an actionable message pointing at System Settings → Privacy & Security → Screen Recording → enable Patch, then restart Patch (a user-cancelled picker stays silent — it's not an error). Paste (`⌘V`/`Ctrl V`) of a clipboard image still attaches directly. Pasting a long block of text (10,000 characters or more) does not fill the input: it attaches as a document named `Pasted – <first six words>.md` (`Pasted text.md` if the text has no words), like any other file; shorter text pastes normally. The whole chat panel is also a drop target — header, banners, transcript and composer alike, so a file does not have to land on the narrow composer strip: dragging any file, a folder, or a `.zip` onto it and releasing attaches it exactly as the paperclip would (a dashed outline plus a "Drop to attach" hint mark the target while dragging over the panel, "Can't attach right now" where the paperclip itself is disabled — offline, no Claude credential, or a new chat still being created for the send). A dropped folder is walked recursively via the browser's directory-entry API and every file inside becomes its own attachment, named with its path relative to the folder (`my-folder/notes/todo.txt`) so files that share a basename in different subfolders don't collapse into one chip; a `.zip` is not expanded — it attaches as the single archive file it is, the same as any other non-image file. First-message-with-attachment on a NEW chat works: sending from `/chats/new` creates the chat FIRST (to get a real chatId), opens it with the message pending, uploads the attachment(s) to that chatId, THEN delivers the turn (a retry after a failed upload reuses the same chat). Images are downscaled on a canvas for the agent's copy while the full-size original is the one stored, served and rendered (`15-design-mobile.md` § Composer). Attachments render inline in the stream; tapping an inline image opens an in-app lightbox (full-screen overlay, scroll/click-to-zoom + drag-to-pan, Esc/backdrop closes) rather than a new browser tab. The lightbox is portalled to the document root, so it covers the ENTIRE window (sidebar, header and all), not just the message column: `.chat-main` sets `contain: layout`, which makes it the containing block for `position: fixed` descendants, and an overlay rendered in-tree is therefore clipped to the chat panel. Attachments persist on replay — the host reconstructs the refs from its per-chat manifest and strips the appended `[Attachments]` path block from the message text, so a re-entered chat re-renders the image/file rather than a literal `[attachments]` string. An image-only message (an attachment with no typed text) still renders its image, empty text and all. Titles and previews strip the `[Attachments]` block: a pasted-image-only chat is labelled `Image` (or the file's name).
- Transcript render cost is O(changed), not O(transcript). A long chat is the normal case, and an assistant turn arrives as one message delta per token. Each transcript entry is an independently memoised render unit keyed on its own immutable entry object: an event touching one entry — a streaming delta, a permission resolving, a delivery flag flipping — re-renders only that entry, leaving every settled message, tool call and inline diff untouched. The callbacks the transcript passes down (permission, approve-all, unqueue, promote, retry-delivery) are referentially stable, without which the memoisation does not hold.
- Edit / fork a turn, and switch tracks (`04-chats-and-folders.md` § Branching): hovering (or focusing) a user turn reveals a pencil affordance to its left — reachable by keyboard (focus) and touch as well as hover. Clicking it swaps the bubble for an editable field pre-filled with that turn's text, plus Save / Cancel; Save fires `chat.fork_request` and the transcript re-loads on the new track. Where a turn is a fork point, a track switcher sits under it — `‹ 2/3 ›`, arrows only, no explanatory copy — firing `chat.branch_switch_request`. The switcher appears once a chat has been forked. A side thread (§ Side threads panel, below) is never one of these tracks — it carries its own marker instead, and never a slot in this switcher, since it never becomes the active track.
- Side thread trigger: hovering (or focusing) ANY settled message — user or assistant, not only a user turn — reveals a second icon-only affordance beside the pencil; right-clicking the message offers "Open side thread" in its context menu alongside the existing actions. Either opens the Side threads panel (below) on a fresh, not-yet-sent draft quoting that message, cursor in its composer. A message with one or more side threads forked from it carries a marker beneath it — "Side thread · N messages" (plus `· running` / `· needs you` while that branch is active) — clicking it opens the panel on that tab.
- Running-turn controls (see § Sidebar §2b for the passive readout of which tool is currently in flight): Stop is the emphasised control whenever a turn is running — it carries the danger colour, and the send button, which can only queue, recedes to an outline. While the chat is `running`, a Stop button appears in the composer actions (and `Esc` in the composer interrupts) — it fires `chat.stop_request`, closing the SDK query mid-turn. The composer stays enabled while running: sending queues the message behind the in-flight turn (`04-chats-and-folders.md` § Message queueing). Queued turns render in the transcript dimmed/dashed with a Queued chip and a remove (×) affordance that cancels them (`chat.unqueue_request`) before they run. A queued turn also carries a promote (↑) affordance, always visible (not hover-revealed — it is the queued message's most useful control and must not depend on discovering hover): it fires `chat.promote_request`, which interrupts the running turn so the queue starts draining now (it does not reorder the queue — turns already queued above the promoted one stay above it) (`04-chats-and-folders.md` § Message queueing). ↑ sits to the LEFT of the × in the queued chip row — the constructive control before the destructive one. Every ↑ reads `Run next`; no key promotes, and nothing promotes on a timer (`04-chats-and-folders.md` § Message queueing). An interrupted turn says so: a stopped turn produces no reply and no error, so on `chat.stopped` any half-streamed reply settles (its caret goes) and the message that was running gets a status line — never worded "cancelled", since the agent already saw the message in both cases below and nothing was actually cancelled. Which status depends on whether the chat's `activity` is still `running` when `chat.stopped` arrives (`09-notifications.md` § A turn the user stopped — a bare stop settles `idle` first, a promote never does): still `running` means a newer queued message was promoted ahead of it, so the message gets a muted `Interrupted.` with no action — the promoted turn's own run already resumed the same session, so there is nothing to retry and retrying would duplicate it; otherwise the user pressed Stop/`Esc` with nothing queued, so the message gets a muted `Stopped.` with a `Continue` button that sends a fresh turn with the text `Continue` (not a resend of the stopped message — the agent already has it in context, and resending would duplicate it). Both read muted, the same place and shape as a failed turn's line (`12-error-and-offline.md` § Guaranteed input delivery), since neither is an error. A turn that got a real reply before any of this carries neither status.

## Side threads panel

`04-chats-and-folders.md` § Side threads / § Parallel branches — step 2 of 3: side branches run (step 1) and send back (step 1), with somewhere on screen to see and drive them from. Docks on the right of the chat, like the Tools sidebar (§ Layout: "All column dividers are drag-resizable") — its own column, own resizable divider (~420px default, floored at 360px, capped viewport-relative), the main chat stays fully usable on the left. Opens from either trigger above (hover button / context menu on a message) or the Threads icon in the chat header's action rail (`chat.branches` already tells the header how many side threads this chat has, for a badge). Belongs to the chat it was opened for: it docks only while that chat is the active tab of the focused pane (§ Panes and tabs), and is hidden — not closed — while another chat or page has focus, returning with its tabs and drafts when focus comes back. It follows the focused tab, never the address bar.

- **Tabs.** One tab per side-thread branch of the open chat (`chat.branches`, filtered to `sideThread: true`), in creation order unless dragged into a different one (drag-to-reorder, session-only — not persisted across reloads). Each tab shows a status dot and the branch's name (falling back to its `side N` label until naming lands): the dot reads `needs you` (an outstanding branch-tagged `chat.permission_request`) over `running` (the branch's own `chat.branches.running`) over idle, same priority order `chat.state.activity`'s aggregate uses. A close control (×) hides the tab — the thread itself is untouched and reachable again from its marker or a fresh trigger. The tab strip is drawn exactly as a pane's tab bar (§ Panes and tabs), with the panel's own close control at its trailing edge. An unsent draft is a "New thread" tab and carries the same close control; closing it discards the draft. Closing every tab (and there being no draft) closes the panel.
- **The trigger's draft.** A tab opened by the trigger (hover button / context menu / "branch again" below) is a DRAFT, not yet a branch — the host mints branch ids, so there is nothing to show until the first message actually sends. It renders the quoted "Off <message>" line and an empty, focused composer; nothing else. Sending fires `chat.side_request` (the active-chat trigger) and the draft is superseded by the real tab the moment `chat.branches` reports the new branch — this is a pull/poll-based substitution, not a live push, consistent with a side branch's content never being broadcast live.
- **Each real tab is a small chat of its own:** the "Off <quoted message>" line, a transcript of that branch's own track (pulled via `GET /api/chats/:id/history?branchId=`, polled every few seconds while the branch is `running`, fetched once on open otherwise — § Parallel branches' pull-based content), its own composer (`chat.input {branchId}`), its own Stop when running (`chat.stop_request {branchId}`), and its own permission/question cards for that branch's `chat.permission_request`s — routed here rather than the main transcript, which draws only the active branch.
- **Branching again from inside the panel.** The same hover/context-menu trigger works on a message inside a tab's own transcript, parented to THAT tab's branch (`chat.side_request {branchId: <this tab's branch>}` — `04-chats-and-folders.md` § Side threads, "Branching off a side thread"). The new one opens as another tab, draft first, same as any other trigger.
- **"Send back to chat"** sits on every real tab, always available (not only while a turn is running) — `chat.send_back_request {chatId, branchId}`, the direct, surface-triggered form of `04-chats-and-folders.md` § Send back. Reads `Sent back` and disables itself once the branch's `sentBack` flag is set; the row it posts into the parent track is drawn as ordinary transcript furniture there (`branchSendBack`), same as the agent-triggered form.
- A message with side threads carries its marker in the MAIN transcript regardless of whether the panel is open (§ Main chat panel, above); clicking it opens the panel on that tab, re-opening a closed one if needed.

## Tools panel

Todoist, App Updates: "for chat tools, tools should show in its own sidebar on
right hand side." Opened from Tools in the chat header's `⋯` overflow menu
(§ Chat panel header), Tools is its OWN sidebar on the right (§ Layout
(desktop)) — a column of its own beside the chat, not a takeover of the left
sidebar and not a modal. The left sidebar keeps showing whichever view (Chats,
Batch or Manager) was showing, the chat itself only narrows, and there is no
backdrop: the tool list and the transcript whose tool calls it explains are
readable at the same time. A close button in the panel's own head, or Escape,
closes the column.

The panel belongs to the chat it was opened for. Navigating anywhere that is
not that chat — a different chat, a new chat, jobs or settings — closes it,
since its toggles write that chat's off set and would otherwise be editing a
chat that is no longer on screen. Switching the left sidebar's view is not
navigating away and leaves the panel open.

It lists the inventory of what the agent can call — the built-in tools, then
Patch's own — each showing its name, what it does, its parameter definition,
and a toggle. The off set is per-chat, persisted, and sent with the chat's
input so the host drops disabled tools from the model's context.

The tool inventory scrolls as its own region below the fixed head; the category
groupings are headings within it, not separate scroll panes. The per-tool
description stays: it is the panel's content, not
helper text — one sentence saying what that tool does, and the only prose in
the panel (§ Copy — no helper text, Tool descriptions are the one content
exception).

## Monitors (historical)

A monitor was the agent's built-in `Monitor` tool: a background script whose
every stdout line arrived back in the chat as an event. `Monitor` and
`TaskStop` are disallowed now (`sdkBackend.ts`'s `DISALLOWED_NATIVE_TOOLS`,
principles.md § Tool ownership) — the watcher ran inside the turn's own
process, so a host restart killed it silently and the host had no pid to
stop it with either. `patch_watch`/`patch_watch_stop` are the durable
equivalent and are what the agent reaches for now, so no chat can arm a new
monitor and there is no live Background task bar row for one any more.

A chat whose transcript predates this still replays correctly: in the
transcript a `Monitor` call remains a tool-call row like any other, summarised
as `Monitor · <description>` with its command on the row; `TaskStop` reads as
`TaskStop · <task>`.

## Links and the web panel (desktop shell)

Patch has a browser of its own — the right-docked web panel — and the user
chooses, link by link, whether a page opens in it or in their real browser.
Both routes are always one gesture away, and every page in the panel can be
popped back out, so nothing is ever stuck inside a browser Patch is worse at
being.

- A PLAIN click on an external `http(s)` link opens it in the Patch panel.
  The Patch SPA itself stays put — the panel loads beside it (see the side-panel
  rules below), so the chat the link came from is still there to go back to.
- A MODIFIED click — ⌘/Ctrl/Shift — or a link that asks for a window of its own
  (`target="_blank"`, `window.open`) goes to the user's REAL browser
  (`shell.openExternal`). These are the browser's own "open this somewhere
  else" gestures, and somewhere else means the real browser: Patch never spawns
  a second Electron window for a link. This is also how a same-origin
  `target="_blank"` (a served attachment, a file link) leaves — the user asked
  for it outside this window.
- The right-click link menu carries BOTH routes by name — Open Link in Patch,
  Open Link in Browser — plus Copy Link Address. Naming them is what makes the
  choice discoverable; the plain-click default is the first of the two.
- A same-origin plain click is an ordinary in-app route, not a panel page: the
  panel is for the web, not for a second copy of Patch.
- A non-`http(s)` scheme (`file:`, `javascript:`, anything unparseable) is
  blocked outright on every one of these paths rather than guessed at or
  followed.
- A SHIFT-click on an IN-APP link is swallowed by the renderer before any of
  this applies. Each Patch window's whole live state (socket, streaming
  messages, drafts, batch, open editor) lives in that page, and the router has
  no route for a browser-driven new-tab open — it hands the modified click
  straight to the browser, which in the clicked window means a full same-origin
  page load: the app appears to refresh and everything in flight is lost. So a
  shift-click on an in-app link does nothing to the window, and shift instead
  means range-select (§ Selecting multiple rows (shift-click)): on a sidebar
  chat row it extends the selection, and anywhere else it simply does nothing.
  A shift-click on an EXTERNAL link is left alone — the rule above already
  keeps it out of this window by handing it to the real browser.

Patch itself also opens the panel, for pages it wants to show you (an artifact,
a preview, a page an agent asks to display), opened programmatically by the
shell/renderer rather than by a click. A Patch-opened page and a user-clicked
link share one panel: the second URL navigates the panel that is already there.

The panel is a side panel, not a full-window takeover:

- It docks to the right edge, full height, taking a fraction of the window
  width (~42% by default, floored at 360px and capped at ~85%, leaving the
  sidebar and a usable chat column visible), with the Patch UI inset by
  exactly that width so the chat and composer stay visible and usable beside
  it.
- The divider between the Patch UI and the panel is drag-resizable like every
  other column (§ Layout: "All column dividers are drag-resizable"): dragging
  it moves the panel's real bounds and the Patch UI's inset live, not just on
  release, since the panel is a native view rather than a page element the
  renderer can resize on its own. Double-clicking the divider resets the share
  back to the ~42% default. The dragged share, not a fixed pixel width,
  persists across opens and restarts, so a window resize keeps the same share
  rather than snapping to whatever pixel width the last window happened to
  produce.
- A slim toolbar strip sits at the top of the panel: back / forward / reload, the
  current URL read-only, an open in browser button, and close. Icon buttons
  with tooltips, no explainer text (§ Copy — no helper text).
- Open in browser hands the panel's current URL to the real browser and closes
  the panel — the escape hatch out of the embedded view, and the other half of
  the choice: a link opened in Patch can still be finished in Chrome.
- Opening a second URL navigates the existing panel rather than stacking
  panels; close tears it down and removes the inset. A link followed inside
  the panel stays in the panel. Only one panel exists at a time: a link clicked
  in a detached chat or sidebar window (§ New windows) moves the panel to THAT
  window rather than opening a second one, and the window it left gets its full
  width back.
- A page that fails to load shows the browser's own error; nothing
  silently reroutes to the real browser or to the SPA.

## Browser permissions (desktop shell)

The shell runs the SPA inside a browser it owns, and hands that browser one
allowlist: the app's own origin may use the microphone and may WRITE to the
clipboard. No other permission is granted, and no other origin is granted
anything. The microphone carries voice notes and voice calls
(`07-voice-app.md`); the clipboard write carries the code block copy control
(§ Main chat panel) and Copy report on the connection diagnostics screen
(`12-error-and-offline.md` § Connection diagnostics screen). Reading the
clipboard is not on the list — nothing in Patch needs whatever the user last
copied.

The list is complete rather than minimal because deciding one permission means
deciding all of them: a shell that answers only for the microphone leaves every
other permission refused. That refusal reads as a broken feature rather than a
denied permission — the copy button just says the copy failed — and a plain
browser grants both of these itself, so the gap appears in the packaged shell
alone.

## Message links

An `http(s)` link in a message carries a small icon beside it. Clicking the
icon expands an inline preview card directly below the message showing the
linked page's title, description and image, fetched server-side. The image is
fetched through the server as well, since the page's own image lives on another
origin that the app's image policy refuses. Clicking again collapses it. To the
right of the preview icon sits an open in browser icon, which opens the link in
a new window — on the desktop shell that is the user's real browser (§ Links
and the web panel). The link itself still follows the normal link-click rules
above — the icons are an addition, not a replacement.

A link to another chat — `/chats/<id>` or `patch://chats/<id>` — is an in-app
link: it carries no preview or open in browser icons, and a plain click opens
that chat in the current pane without a page load. A modified or middle click
keeps the browser's new-tab meaning.

## New windows

Several actions open an explicit second window, distinct from the single-window
default above and from the browser's own implicit new-tab gesture (§ Links and
the web panel): each loads the SPA fresh, with its own socket connection,
independent of the window that opened it — closing one does not close the
other.

- The sidebar's `+ New chat` button (§ Sidebar §8) starts a new chat in the
  current window as normal; it is the main segment of a segmented split button,
  and the caret segment beside it opens a dropdown holding New chat in new
  window, which mints the same fresh draft but opens it in a new window,
  leaving the current window on whatever it was already showing.
- The chat header (§ Chat panel header) carries an Open chat in new window
  icon action alongside its other reversible actions, opening the chat
  currently in view in its own window.
- A sidebar row's right-click menu, and a tab's own right-click menu
  (§ Panes and tabs), both carry the same Open in new window action, for the
  chat that row or tab names rather than only the one currently in view. A
  tab's own menu offers it whatever kind of tab it is — a file, a terminal
  session or a page opens into its own window (`/tab-window`, § Routes) the
  same as a chat does, reusing this same mechanism.
- The sidebar can be detached into its own window from an icon in its brand
  row (§ Sidebar §1): a window showing only the chat list (`/sidebar-window`,
  § Routes), wired to the same live state independently.

In the desktop shell these windows and the main window carry no native title
bar: the app runs to the window's top edge, its top row keeps a strip clear for
the window controls, and that row is what the window drags by. See
`05-surfaces.md` § Window chrome.

Every window opened by one of these actions starts with ITS OWN sidebar
hidden — a focused, sidebar-less view, unless the user separately opens a
sidebar window. On the desktop shell this is a real second Electron window; in
a plain browser tab it is an ordinary new browser window/tab.

The sidebar window opens at a sidebar's width rather than a document's. Widened
past the sidebar's ceiling (§ Layout — desktop) the list stops growing and the
rest of the window is empty sidebar panel, so the window never contains a
stretched chat list.

## Artifacts

Patch's own version of the Artifact tool: the agent writes an HTML file into the
chat folder, publishes it, and the page becomes a thing the user can open — in
the web panel above, or as a plain URL anywhere else. The whole point is that
"here is a page I made for you" is a first-class result, not a paragraph of
markdown or a file path the user has to go and open themselves.

The tool. `patch_artifact({ path, title? })`, one of the `patch_` MCP tools
(`06-threads-manager-speakers.md` § Cross-chat toolset).

- `path` is relative to the chat folder and must resolve inside it — an
  absolute path, a `..` escape, or a missing file is a loud error, rather than a
  silently-skipped publish.
- HTML only (`.html` / `.htm`). Patch does not render markdown server-side;
  the agent writes the page it wants shown. Any other extension is an error
  naming the rule. A fragment (no `<html>` element) is wrapped in a minimal
  document carrying the title; a full document is published byte-for-byte.
- `title` defaults to the file's basename. It is what the chat card and the
  panel show.
- Size cap 2 MB; over it is an error, not a truncation.
- The tool returns `{ artifactId, url, title }` only after the server has the
  bytes. If the host→server link is down or the write fails, the tool fails
  with that reason, so a returned URL always resolves.

Identity and updating. `artifactId` is derived deterministically from
(`chatId`, source path), so republishing the same file replaces the page at
the same URL — the agent iterates on one artifact instead of littering the
chat with near-identical copies. A different path is a different artifact.

Serving. `GET /api/chats/:chatId/artifact/:artifactId` returns the stored
HTML (`01-server.md` § Endpoints). Never public: it needs a surface bearer, or a
signed link. A plain `<webview>`/`<iframe>`/`<img>` cannot attach a bearer
header, so the URL the server returns at publish (and which the card carries)
ends `?sig=<HMAC>` — a signature over (chat, artifact) under a server-held
secret, so knowing or guessing the ids is not enough. A missing, wrong or
tampered signature is a 401, never a fallback to open access. It is served
with `Content-Security-Policy: sandbox allow-scripts` — the page runs in an
opaque origin, so agent-authored script can neither read the SPA's stored
credential nor make same-origin API calls with it. An unknown id is a 404;
nothing is generated on the fly. A card published before signing existed
carries an unsigned URL and 401s until the file is republished.

Sharing. The in-app link is for the signed-in user's own surfaces; to give
someone else access, an authenticated surface calls
`POST /api/chats/:chatId/artifact/:artifactId/share { ttlSeconds? }` (default
7 days, 60 s to 30 days) and gets back `{ url, expiresAt }`: a link signed over
its expiry, so extending it by hand invalidates it. `DELETE` on the same path
revokes every share link already issued for that artifact (the in-app link is
unaffected); links minted afterwards work again.

In the chat. A published artifact appears in the transcript as its own
card — title, the source filename, and nothing else (§ Copy — no helper
text). Clicking it opens the artifact in the web panel on desktop (that is
exactly the "page Patch wants to show you" case above) and in a new browser tab
on the web surface. On desktop the panel shows the artifact belonging to the
chat you are looking at: open another chat and the panel shows that chat's
artifact or closes if it has none, leave the chat route and it closes, come
back and it re-opens. Closing the panel from its own toolbar is the user
saying they are done with it, so that chat forgets its artifact rather than
re-opening it on the next visit. Republishing updates the existing card's
timestamp rather than adding a second one for the same `artifactId`. The panel
remembers only the one artifact the chat is CURRENTLY showing; every artifact
the chat has ever published stays reachable above the transcript (§ Main chat
panel — Artifact bar), so an earlier one does not require scrolling back to
find its card.

Wire frames: `chat.artifact` (host → server → surfaces, slim — no page body)
and the `patch.artifact.publish_{request,response}` pair (host ↔ server),
both in `03-wire-protocol.md`.

## Pads

A Pad is a design space: a set of screens Tom edits directly while the chat that owns it acts on what he changes. It is how "here is a design to react to" becomes something he can touch instead of a description or a screenshot. Pads live in the server, are reachable from every surface, and belong to exactly one chat.

Where they live. The Pads entry sits above Jobs in the sidebar's lower navigation, carrying the count of changes Tom has made on Pads and not yet sent. It opens the Pads page: a search field, New Pad, and the Pads grouped by the app they design for (a Pad with no app is grouped under No app). Each is a card with a picture of its first screen, its name, the chat that owns it, when it last moved, and a badge: Working while a batch he sent awaits the agent's reply, otherwise the number of pending changes, otherwise none. Clicking a card opens the Pad.

Opening a Pad. A Pad opens in a pane directly to the left of its owning chat, opening that chat first if it is not already in the layout; a Pad already open is focused, never opened twice. The pane header names the Pad (click to rename), the app and chat it belongs to and its badge, with a way to the chat and Delete (confirmed). Everything below the header is the editor.

The editor.

- Screens. A Pad is a set of screens, listed by the agent in a `pad.json` manifest (`{ screens: [{ id?, name, path, width? }] }`, `path` a file in the Pad optionally with a `#fragment`) or, without one, one screen per top-level `.html` file, `index.html` first, named by its title. Every change belongs to one screen and shows only there. A + after the last screen (on a phone-sized pane, at the right of the ‹ › bar) adds a blank screen named `Screen N` and opens it; it is shown even when the Pad has one screen. The screen list shows each screen's pending-change count and a dot on a screen added since Tom last opened the Pad; on a phone-sized pane it becomes a ‹ › bar. A screen listed with a `width` is held at that width, the stage scrolling sideways, so a captured layout never reflows into a different one.
- View and Edit. View lets the design work as itself, taps navigate. Edit has three tools: Select (tap to select; with a mouse, dragging across unselected design draws a dashed box and selects the smallest element that contains everything the box touches fully inside it, or the element where the drag began when the box holds nothing whole, while a finger's drag still scrolls; drag a selected element to move it; corners resize; double-tap edits text; Delete or ✕ removes; ⌘D duplicates), Note (tap anywhere and type; a note sticks to the element under it) and Draw (a freehand pen; strokes stick to what they surround). Keyboard: arrows nudge (Shift ×10), Enter edits text, Shift-Enter selects the parent, Tab and Shift-Tab walk siblings, Esc deselects, ⌘Z and ⇧⌘Z undo and redo, V N D choose tools, E toggles View/Edit, Page Up/Down change screen, ⌘Enter sends, ? lists them.
- Desktop and Phone. The Pad opens in the device the agent or Tom chose; Tom's own choice for that Pad wins afterwards. The mode, device and panel state are remembered per device.
- Changes. Every change is stored on the server the moment it is made, so every device sees the same pending changes, notes and drawings, replayed onto the design in the order they were made (a duplicate's copy exists for everything recorded after it). Repeated moves, resizes and text edits of one element while pending fold into one change; notes, drawings and deletions never do. The numbered Changes list names each change by where it sits (`in Agent › Defaults › "Permission mode"`) and removes it with ✕. Every change added, edited or removed is also appended to a per-Pad journal, so nothing is lost to a delete.
- Send. Send draws a picture of every pending change — its screen opened at the size Tom was viewing, his other pending edits applied, scrolled to the change and marked (a move shows where it came from, a deletion is hatched, notes and drawings as he left them) and numbered to match — and delivers one message into the owning chat as a user turn: the changes grouped by screen, each with its picture's link, its selector and a plain description, and how to act and reply. The batch stays pending if the pictures cannot be drawn or the chat no longer exists, with the reason shown. Sent changes show under Sent with the pictures and, once the agent replies, the reply; until then they read Waiting for the chat. The design reloads itself when the agent updates its files.

Starting a Pad. Three ways, all ending with the Pad open beside its chat.

- Design a change to Chat. In a chat's menu, this photographs the screen as it looks right now into a Pad owned by that chat. The photograph is the real interface — the live page with every style, font and image inlined and scripts removed, links inert — never a mockup, and it is taken after the menu has closed.
- An agent creates one with `patch_pad_create` (`06-threads-manager-speakers.md`); a card appears in its chat.
- New Pad. A name; Based on Blank or an app, then which of that app's real screens to start from; Desktop or Phone; the owning chat; Create. For Patch the screens are Patch's own pages (New chat, Jobs, Settings, Pads), each photographed live at the chosen device's size when Create is pressed. For any app, earlier captures are offered as pictures to pick. Blank starts with one empty screen.

The agent keeps working on a Pad. `patch_pad_update` replaces a Pad's files with the folder's current contents: Tom's pending changes stay, an open editor reloads, and screens the agent adds are announced. `patch_pad_reply` answers the oldest open batch and marks its changes done. Only the owning chat may update or reply.

Pad cards. Creating, updating or replying stamps a card into the owning chat (a `chat.artifact` whose id is `pad-<padId>`): a picture of the first screen, its name and screen count, its badge, and Open. Updating the same Pad refreshes the one card.

Access. The editor and the Pad's files are served from a URL signed over the Pad's id, because they load in a frame that cannot attach a bearer header; the Pads page, creation, rename and deletion need a surface bearer. The editor reaches into the design's document, so the design runs same-origin with Patch rather than in an opaque origin; Pads are authored by Tom's own agents.

Screen capture. The photograph of a screen other than the one on show is taken by loading that route in an off-screen frame of the app with a throwaway layout that persists nothing and marks nothing read, which is why the app may be framed by its own origin.

## Viewing files

`view_file({ file_path })` shows a file to the USER. It is the inverse of
`Read`, and the distinction is who the bytes are for: `Read` pulls a file into
the agent's context so the agent can work on it, `view_file` puts it on the
user's screen and tells the agent nothing about it. Both exist because both
things are wanted, and conflating them is what made "show me that screenshot"
cost a context window.

- Images (`.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`) render as a picture;
  `.pdf` renders in the browser's own PDF viewer; `.html` renders as a live
  page. Any other extension is an error naming `Read` as the thing that was
  probably meant — text has no business here.
- `file_path` may be absolute or chat-folder-relative, because the agent has
  usually just been handling absolute paths and demanding a relative one is
  friction. It must still resolve INSIDE the chat folder; containment is the
  boundary, not the spelling of the argument.
- Size caps are on the SOURCE file: 1.4 MB for an image or a PDF, 2 MB for an
  HTML page. A PDF is inlined as a base64 data URI, which costs 4/3 — capping
  the source is what stops the wrapped page exceeding the artifact ceiling and
  bouncing at the server. An image is served at its own URL instead, so its
  cap only has to clear that same ceiling once base64-encoded for transport
  over the host↔server link, with no wrapper overhead to leave room for.
- The tool returns only `{ ok, kind, url, name, path }`, after the server holds
  the bytes. The file's contents are never in the return value: that is the
  entire point, and a returned URL always resolves.

Serving and rendering. An image is served RAW — its own bytes, its own
content-type — because the frontend puts the URL straight into an `<img src>`,
which needs real image bytes to decode; an HTML document at that URL, however
it wraps them, is a broken image icon. A PDF or an HTML page is instead
wrapped as a page and stored and served exactly like an artifact (§
Artifacts) — same store, same signed URL, same
`Content-Security-Policy: sandbox allow-scripts` opaque origin. Either way the
`viewId` is namespaced apart from the `artifactId` for the same path, so
viewing a page never overwrites the artifact card published from it.

In the chat, a `view_file` call renders as the file itself: the tool's row IS
the picture or the page, with the filename above it. An image renders as an
actual `<img>`, click-to-open in the same full-screen lightbox as any other
inline image (§ Attachments); a PDF or an HTML page renders in a
`sandbox="allow-scripts"` iframe (no `allow-same-origin` — the credential is
unreachable from both sides of the boundary), with an expand control above it
instead, since neither is a lightbox candidate. It deliberately does NOT stamp
a `chat.artifact` card,
because it is not publishing a destination — it is showing something where the
conversation is. A `view_file` whose result is not a valid ack (an error, say)
falls back to the ordinary tool row so the failure is visible; it never
renders an empty frame.

## Terminal

A shell on the chat's own host. It exists because the host is remote: cloning
a repo onto it, running an install, or looking at what is actually on disk has
no other route from a surface. Contract in `02-daemon.md` § Terminal sessions;
wire frames in `03-wire-protocol.md` § Terminal sessions.

A terminal session is a pane tab (§ Panes and tabs), like a chat, a file or a
page: `` ⌃ ` `` toggles it (open/focus, or close if it's already the active
tab) for the active chat, from anywhere in that chat view. Opening it follows
the same opening rules as any other tab (§ Panes and tabs § Opening things) —
a plain open replaces the active tab, a middle-click/"Open in new tab" adds it
beside what's there, "Open to the side" splits a pane for it. There is no
separate drawer form and no on-screen toggle button: closing the tab (`⌘ W`,
or the tab's own close control) hides the session; `` ⌃ ` `` or reopening it
through any of the usual entry points brings back the same scrollback and
command history, since the session itself lives on the host, not in the tab.

- Rooted at the chat's folder, on the chat's host — and available on
  `/chats/new` too, where it matters most: you are on that screen precisely
  because the folder you want does not exist on the chosen host yet, and a shell
  is how you clone it there. There it opens on the host selected in the folder
  picker; with no folder to name, the surface claims none and the host roots
  the shell itself (`02-daemon.md` § Terminal sessions) and reports the real
  directory back. The terminal header always shows the daemon-reported cwd. A long
  path is elided at the front, keeping the trailing directories that
  identify it; the whole path is on hover. Naming a
  folder that does not exist is still a loud error — only omitting one is a
  request.
- Output pane + input line. Monospace, on a recessed surface of its own that
  follows the app theme (§ Theming) — light in light mode, dark in dark. Output
  streams as it arrives (stderr tinted red), auto-scrolled to the bottom unless
  the user has scrolled up. The input line sends on `↵`; ↑/↓ walk this session's
  command history.
  - The stderr tint is a _stream_ marker, not an error marker. The shell runs on
    separate pipes rather than a pty (`02-daemon.md` § Terminal sessions), and
    the tools people actually run — `git`, `pnpm`, `curl` — write progress and
    status to stderr, so whole screenfuls of ordinary output arrive on it. The
    tint must therefore be sized for reading walls of body text, not for the
    occasional shouted line: see § Theming for the contrast floor it carries.
- `Ctrl-C` (in the input line, or the stop button) sends `SIGINT` to
  the running command, not to the session.
- The prompt row says whether the command it last sent is still running: a
  pulsing marker beside the input, naming `⌃C` as the way to interrupt. Without
  it a command that prints nothing and finishes instantly looks identical to one
  that has taken the session over and will never return, and the key that gets
  out of the second case is the one thing the shell cannot say for itself. The
  marker sits still under a reduced-motion preference. A command that could not
  be sent at all is not shown as running.
- A command finishing clears the marker and adds nothing to the scrollback; the
  prompt going quiet is what says it is done, and a notice after every `ls`
  would bury the output it followed. A NON-ZERO status is stated, as a dim
  `exit <code>` line — there is no prompt carrying the status and no `$?` to
  read afterwards (`02-daemon.md` § Terminal sessions). A session that ends
  stops claiming to be running, whatever it was running at the time.
- The app itself can open the terminal carrying a command to run — the
  background task bar does (§ Main chat panel). It is held until the session is
  live and then run down the same path a typed line takes, so it is echoed and
  remembered like any other; at most one is held per chat, and it runs once.
- One session per chat, kept alive while the app is open — dismissing the
  terminal hides it, it does not kill the shell; reopening shows the same
  scrollback. Switching chats switches sessions. A session that ends (shell
  exit, idle timeout, host restart) says so inline and offers Restart.
- Errors are shown: a folder that does not
  exist on the host, an unknown session, a daemon-offline send — each renders
  in the terminal as an error line.
- After a clone, the new folder is immediately usable: the folder picker's
  browse tree re-reads the host on open, so a repo cloned into a project root
  shows up without a reload.

## Editor — two surfaces

A file is one of two distinct editor surfaces, both embedding Monaco (the editor that powers VS Code), using its built-in diff editor and standard editor — both write via the same `file.write` wire event, and differ in where you enter from and what you see. Language detection comes from Monaco; colour does not — every Monaco surface is painted from the app's own palette and follows the OS light/dark preference live (§ Theming), so an editor is never a light rectangle inside the dark app, and added/removed lines stay legible against the dark surface. Every open file is its own pane tab (§ Panes and tabs) — one tab per file, on the opening rules that section describes — rather than a docked rail: a file tab closes, splits, drags and persists exactly as any other tab does.

A third kind of file gets a third surface instead of Monaco — see § Document editor, below the file browser.

### Diff editor (entered from an agent edit)

- Clicking a tool-call line in the chat stream, or `⌘'` on the most recent edit, opens (or focuses) that file's tab showing the diff, on the same tab-opening rules as anywhere else (§ Panes and tabs § Opening things) — a plain open replaces the active tab. An edit touching several files opens one tab per file in the change set (§ Panes and tabs § Opening things covers duplicate-open; here each file in the set gets its own tab rather than one surface listing all of them), with the file actually clicked left focused; switching between them is the pane's own tab bar, the same as switching between any other open files.
- Unified diff is the only comparison view. Click any `+` or `−` line to edit it in place before saving. The line becomes a yellow editable box; Save (or `⌘S`) commits the file with your tweak. Markdown wraps here too, on the same rule as the file browser's editor.
- A file with nothing on the original side — a whole-file write with no committed baseline to compare against — opens as the standard single-pane editor showing the file itself, directly editable. Rendering it as a diff would paint the entire file as one block of additions, which carries no information. Nothing else changes: same header, same path, same Save / Approve / Deny controls, same `file.write`. The choice is per file and rests on whether that file has an original side, so a change set can mix diffs and plain files, and a write over a file that does have a baseline stays a diff.
- Writes back via a `file.write` wire event → the chat's own host writes to disk; the target chat sees nothing unless you've also referenced the file in the composer. Paths are resolved on that host, so the editor and file browser show that machine's filesystem.
- Editable whatever the chat is doing — a save is never held back waiting for the agent to go idle, and there is no read-only state to wait out. The host writes atomically (temp file, fsync, rename), so a save landing mid-turn replaces the file whole rather than tearing it against the agent's own writes.

### File browser (entered from the chat header's Editor icon, `⌥ E`, or `⌘ ⇧ '`)

For poking around the chat's repo. The tree is its own `{kind:'page', page:'files'}` tab (§ Panes and tabs) — opening a file from it opens (or focuses) that file's own separate tab, on the same opening rules as everywhere else, rather than filling a second pane of the same surface; the tree tab and an open file are independent tabs that can sit side by side (split) or replace one another, same as any other two tabs:

- Tree on the left (~280px), rooted at the chat's folder. Folders bold. A green `●` next to a filename indicates pending changes (recent agent edit OR your unsaved tweaks).
- Dotfiles and dot-directories (`.env.local`, `.config`, …) are listed like anything else — this is a full view of the repo, and hidden config is often exactly what someone opens the browser to find. `⌘P` is the one exception: its project-wide index stays filtered to non-hidden files, since it's a fuzzy jump for source, not a repo browser.
- Navigation is a breadcrumb, not a `../` row. The tree header carries a clickable breadcrumb: a root crumb (`/`, the chat's folder) followed by one crumb per directory drilled into, in order. Clicking any crumb navigates straight to that level — from `src/components/panels` back to `src` is one click, not three. The current (last) crumb is not a button; it is the plain label of where you are. There is no `../` row: the breadcrumb replaces it, because climbing one level at a time through a list row is the slowest possible way to move in a tree and it reads as chrome cluttering the file list.
- Ordering is deterministic: directories first, then files, each A→Z case-insensitively. The host returns entries in filesystem order, which is effectively arbitrary — the same folder can list differently between reads, so nothing is where you last saw it. Sorting client-side makes the tree scannable and stable.
- Filter box at the top of the tree — a persistent input that narrows the CURRENT directory's rows by case-insensitive substring on the name (dirs and files alike). It is the "I can see the folder, I just want to cut it down" tool, distinct from `⌘P`, which is the project-wide fuzzy jump.
- The tree carries no "currently open file" marking of its own: an open file is a separate tab now (§ Panes and tabs), not a second pane of the same surface the tree highlights into, so which file (if any) is open is read off the tab bar, not the tree.
- Empty states are explicit: a directory with no entries reads `Empty folder`; a filter matching nothing reads `No matches`. A listing that failed reads as the reason it failed, in place of the rows — a directory that could not be read is not an empty one, and the breadcrumb above stays live so the root is one click away.
- Loading is drawn, not implied. While a directory listing, a file's content or the `⌘P` index is being fetched for the first time, its pane shows a skeleton — grey bars at the height of the rows they stand in for, no copy — rather than the shape that fetch would have if it had come back with nothing. An empty folder, an empty file and a picker with no matches are all real states, so a fetch in flight must not borrow them. The editor's skeleton covers the editor and leaves the meta strip visible, so the file being loaded is still named, and `⌘P` shows its own skeleton rather than standing the current directory in for the project-wide index. Moving between directories is not a first load: the previous listing stays on screen until the next resolves. A fetch that fails leaves the loading state at once for the error toast above; a failure never settles into a permanent skeleton.
- Creating: the tree header carries a `New file` and a `New folder` button, beside the breadcrumb that says where the new thing will land — the breadcrumb is already the answer to "which directory", so the create controls sit against it rather than asking again. Each creates an "untitled" entry on the host immediately — no name prompt — and drops the tree straight into renaming that row in place (typing a real name and committing replaces "untitled"; Esc leaves it as "untitled" rather than deleting it). A new FILE also opens, in a pane split beside the tree (not a plain open, which would replace the tree's own tab with the file it just created) — since the point of making it is to type in it, and that doubles as proof the host really has it; a new folder has nothing to open.
- Row actions: every tree row carries a `⋯` actions button (and the same menu on right-click) holding `Rename` and `Delete`. Rename takes a path relative to the chat's folder rather than a bare name, so it also moves a file; the prompt says so, and says that the destination folder must already exist. Delete asks first — a modal naming the exact path, with a danger-coloured confirm — because it is the one action in the browser that cannot be undone. A folder's confirmation also says only an empty folder can be deleted, so the refusal is not a surprise sprung after the confirm.
- These are host operations, awaited, and nothing is optimistic: the tree is re-read only once the host has said what it did, and a refusal (the name is taken, the folder is not empty, the path escapes the chat folder) surfaces as the host's own sentence in the error toast with the tree left exactly as it was. Nothing is overwritten and no delete recurses, so a refusal is the normal answer to a real conflict rather than a failure to handle one. The open file follows what happened to it: renamed, the editor follows it to its new path; deleted — or moved or deleted along with its folder — the editor closes rather than sit over a path that is no longer there, where Save would write the file back.
- Search: `⌘P` jumps to file by fuzzy name (project-wide, recursive index).
- Editor on the right: full file, line numbers, syntax highlighted, saved with `⌘S` or the Save button (both do exactly the same thing — commit the open file via `file.write`). `⌘S` belongs to the editor whenever it has a file open, so it never reaches the browser's save-page dialogue; with nothing edited it does nothing. Markdown files open in markdown mode: a paragraph is one long logical line, so lines wrap (continuations aligned with the line they belong to) instead of running off behind a horizontal scrollbar, and the word-based autocomplete popup is off — offering the words already in the document is help in code and noise in prose. Writable on the same terms as the diff editor. Content is fetched over the daemon-link (`GET …/files?path=…&content=1` → `patch.files.request`/`patch.files.response`). A content-load failure (missing file, host offline, timeout) surfaces an error toast and covers the editor pane with the file's path and the reason, so a file that failed to load reads as an error rather than as an empty file someone could type into and save over what is really on disk; Save is not offered until a read succeeds. The same holds for the `⌘P` recursive index.
- Quick switch to diff: meta strip above the editor shows the open file as basename in ink, its directory muted before it (a full path as the primary label is unreadable at narrow pane widths), plus two toggle buttons — `Git diff` and `Agent's edits`. Pressing one replaces the plain editor with a READ-ONLY diff IN THE SAME TAB — nothing navigates to a different tab (§ Diff editor is the same file tab, just arrived at from a tool-call click or `⌘'` instead of the tree). Pressing the pressed button again returns to the plain, editable file; pressing the other toggle switches straight to it.
- Neither toggle is ever clickable through to a "nothing changed" notice — each is greyed out UP FRONT when there is nothing to diff, rather than opening on click and only then explaining an empty result (a file unchanged since HEAD greys out `Git diff` rather than opening a diff of nothing against itself). `Agent's edits` is enabled only when the chat has an edit on this file it can still rebuild: disabled when the chat never touched the file, and disabled — not clickable through to a failure — when the recorded edit can no longer be found in the file (superseded, or changed underneath). `Git diff` is disabled only when the file is byte-for-byte its committed HEAD; a folder with no git HEAD at all is never a reason to disable it — the whole file opens as new, the one-sided rule § Diff editor also uses for a whole-file write with no baseline.
- Scope is per-chat. A chat is pinned to a folder; the browser is rooted there.
- The tree and an open file are independent tabs (§ Panes and tabs): closing a file tab (`⌘ W`, or its own close control) leaves the tree open if it still is, and vice versa; neither closes on its own just because the other did, and neither closes just because the user navigates to a different chat — a tab stays open until its own close control, or `⌘ W`, closes it, the same as a chat tab does.
- The tree's own position — expanded directories, the filter — is remembered per chat and survives the tree's tab closing and reopening, and a reload. An open file's draft is in memory only: it does not survive that file's tab closing, because restoring an edit across a restart would be sitting over a file the host may have changed in the meantime, and saving it would write over that change with nobody having seen both. The whole pane/tab layout itself — which panes, which tabs, which is active — separately survives a reload (§ Panes and tabs), so a file left open is usually still open after one; its draft specifically is what does not survive.

### Document editor

Patch's fourth editor, alongside the file editor above, image markup, and Pad (designs). A plain text editor for an ordinary Markdown document: the file's text is shown and edited as-is in a text area, with no HTML or rich-text conversion on open or on save. A file opened and closed without typing is byte-identical — YAML frontmatter, hard-wrapped prose, blank-line spacing and trailing whitespace are never normalised; only what the user types changes. Mode, suggestions, comments and version history live in the `.patch-doc.json` sidecar as before. Page-layout documents (columns, headers/footers, precise page breaks) are out of scope entirely.

- Opens in place of the file browser's plain editor (above) whenever the open file is `.md`, with "Open as source" in the meta strip (where `Git diff` / `Agent's edits` live) switching to the Monaco code editor for that file; toggling back returns to the text editor. Lives in the same file tab as any other open file (§ Panes and tabs) — same tree, same Save, same `file.write`.
- Select a passage → a small popover offers "Ask about this" and "Comment". "Ask about this" quotes the selection into the chat's own composer draft (a `>` block per line), ready for you to add your question and send — the same composer every other message in that chat goes through, not a side channel. "Comment" replaces the popover with a small inline form; submitting opens a new thread anchored to that passage (§ Comments both ways, below) rather than touching the document's text — offered in every mode.

Everything that is NOT the document's own Markdown — its mode, the agent's tracked suggestions, every comment thread, and its version history — lives in a sidecar beside the file, `.<name>.patch-doc.json`, never inside the `.md` itself. It is an ordinary file otherwise: visible in the file tree, tracked by git like any other, gitignored like any other if that is what's wanted.

**Mode** is a switch in the meta strip (Change / Propose / Comment), one per document rather than per chat — whoever opens the file, and whichever chat, sees the same mode. Only a surface sets it (the select itself; wire: `POST /api/chats/:id/doc/action {op:'set_mode', mode}`) — the agent cannot change its own document's mode.

- **Change**: the agent edits the document directly with its native `Edit`/`Write`, exactly as any other file.
- **Propose**: the agent's edits are tracked suggestions instead of direct changes. `patch_doc_suggest(path, find, replace)` records one — `find` must be an exact, currently unique substring of the document (the same contract `Edit`'s `old_string` holds; a replace of `''` is a pure deletion), refused with the mismatch if it is not. The meta strip's "Suggestions" toggle swaps the editor pane (the same way `Git diff`/`Agent's edits` do) for a list of pending suggestions, each shown as struck-through `find` → `replace`, with Accept/Reject per suggestion and Accept all/Reject all for the batch. Accepting applies that one find/replace to the document (a conflict — the document moved since the suggestion was made — is reported, not silently dropped); Accept all applies every suggestion it still can, in the order they were made, against the document as each prior one left it, leaving any that no longer uniquely match pending rather than failing the batch; Reject (all) only ever changes a suggestion's own status, never the document.
- **Comment**: the agent touches no text at all — only comments.

Direct `Edit`/`Write` on the document is refused outright in Propose and Comment modes, the refusal naming the mode and which tool to use instead (`patch_doc_suggest` in Propose; nothing touches text in Comment) — enforced at the same `canUseTool` choke point the SDK's own safety checks go through (`02-daemon.md` § MCP server), so it holds under every permission mode, Bypass included.

**Comments both ways.** Either side can open a thread anchored to a passage — the anchor is the exact text selected/quoted at the time, not a persisted offset into the document (the document itself can change under it). The user's side is the popover above, or a reply typed into an open thread in the Comments panel (meta-strip toggle, same swap as Suggestions); resolving/reopening a thread is its own button there, and a resolved thread sorts after the open ones. The agent's side is `patch_doc_comment(path, anchor, text)` to open a thread and `patch_doc_reply(path, threadId, text)` to reply in one — both available in every mode, since neither touches the document's text. A user comment or reply reaches the agent as a `<system-reminder>` prefixing its next turn (collapsed row "New comment", spec/02 § System-reminder disclosure) naming the file, the thread and the comment; the agent's own comments/replies need no such reminder back — they already show as that turn's own tool call in the transcript.

**History.** Every real change to the document's content — a surface save, the agent's own direct edit (Change mode), or an accepted suggestion/restore — is kept as a version: the full content, who made it, when. A save that lands back on exactly what was already there is not a new version. The History panel (meta-strip toggle) lists every version, newest first, previews whichever one is selected, and "Restore this version" writes that content back as the document's current one — which itself lands as a further version, stamped with which one it restored from, so history only ever grows forward.

The host-files version guard (§ File browser's save-conflict modal) for a concurrent EXTERNAL change (git, another process) is distinct from this editor's own version history, which never conflicts with itself; until the version guard lands, a save here follows the same conflict check the plain editor uses.

**Word import.** Opening a `.docx` converts it to the Markdown this editor opens — headings, paragraphs, bold/italic/links, lists, tables and images — and opens the result in place of the file. The original `.docx` is left untouched; the converted `.md` sits beside it (same basename). Conversion runs through mammoth (`.docx` → HTML, including real `<table>` markup) piped into `turndown` with its GFM plugin (HTML → Markdown, with table support — mammoth's own Markdown writer has no table handling at all) — pure-JS libraries rather than a host-installed `pandoc`, so the feature needs nothing beyond what `pnpm install` already gives every host. Images extract to real files in a `<name>.files/` folder beside the `.md`, referenced by relative path — never inlined as base64. Anything the conversion can't carry over — tracked changes (baked into the accepted text, their history lost), embedded objects, a multi-column layout flattened to one column — is listed as a warning the moment the file opens, not silently dropped; the warnings are kept in the sidecar (`importWarnings`) so they surface again on a later reopen too. Re-opening the same, unchanged `.docx` is a no-op — the existing `.md` (and any edits made to it since) is left alone — rather than reconverting; a `.docx` that has changed (re-saved from Word) does reconvert, through the ordinary write path, so the previous `.md` content is kept as a version (§ History above) rather than lost.

**Export.** The meta strip's Download menu offers `.docx`, `.pdf` and `.md` for any open Markdown document. `.docx` is built directly from the document's parsed Markdown — real OOXML (a `docx` library document), not an HTML-wrapped file — so it opens cleanly in Word with real headings, lists, tables and embedded images. `.pdf` renders the same content as HTML through a headless Chromium (the `playwright` component already installed for the agent browser, `02-daemon.md` § Browser) into a styled page. `.md` is simply the document's current bytes. Every export writes the file beside the `.md` on the chat's own host (same basename, new extension) — visible in the file browser immediately — and hands the surface the same bytes for a real browser download in one round trip. An image the `.docx` export can't embed (a remote URL, an unreadable path) is named as a warning rather than silently skipped.

The agent reaches both through tools: `patch_doc_convert(path)` converts a `.docx` exactly as opening it would, returning the `.md` path and any warnings; `patch_doc_export(path, format)` writes the export beside the `.md` and returns its path and warnings (not its bytes — reading them back is a separate file read if the agent actually needs the content).

What remains: opening the document from a chat link/card; full-screen mode's table of contents; popping out into its own window; the agent's own Change-mode edits appearing live, highlighted, in an already-open editor; suggestions and comments marked inline in the prose itself (panels render both instead).

## Chat panel header

This is the app's top bar. Three zones sharing one vertical centre-line:

- Back / Forward — the far left of the row, in its own zone, so taking the space does not pull the centred name off centre. Two chevron buttons walking the surface's own navigation history, browser-style: each organic navigation pushes an entry and drops anything ahead of it, and a step that is not available is drawn disabled rather than hidden. `⌘ ←` / `⌘ →` walk the same stack (§ Keyboard shortcuts) — left to the field's own start/end-of-line chord wherever a text field has focus. This is the app's only history control.
- Generated chat name — centred. Fraunces, slightly bigger — e.g. fix layout bug (see `04-chats-and-folders.md` § Name). It carries NO tooltip — the general rule that clipped text carries its full value on hover (§ Copy) is deliberately not applied here, since clicking the name is itself the full-text affordance. A `waiting on you` pill (inline indigo pill with `!`) sits beside it, only in `permission` state — the same `--permission` indigo the sidebar's `permission` badge uses (§ Status badges), because it is the same state on another surface of the same screen. `working` state carries no equivalent mark in this slot: an open running chat already shows that in two other places — the sidebar row's own `working` badge, and the transcript's "Thinking…" dots at its foot (§ Main chat panel) — and a third orange dot here was one signal too many for the same state on one screen. Beside the name, an Open chat in new window icon (§ New windows) — shown for every chat including special threads.

  Clicking the name renames it in place: it becomes a text field seeded with the current name, in the exact same font, size and position as the static name — no box, no jump, only a subtle underline standing in for the box a text field usually gets. Enter commits, Esc cancels, clicking away commits, and an empty submission clears the name back to the derived label. Rename sits on the name itself rather than as a header icon — the obvious place to click is the thing being renamed. Regular chats only; a special thread's name is fixed and stays plain text.

  Underneath the name, one quiet line in the normal UI font (not monospace): the folder basename, then the host name, separated by `·` — the folder leads because it's what a chat is usually placed by, the host follows because the same folder path means a different directory on each machine. Full folder path on hover. Each segment is drawn only where its value is actually known; an unknown one is left out together with its separator rather than standing in as a placeholder. The line itself is absent, not merely empty, when neither segment is known. Suppressed entirely for special threads (Manager / Speakers): their crumb and generated name are identical, so the name shows once (as the title) rather than duplicated.

  After that line, a thin usage bar (no text): how full the fullest pool (session, weekly or extra usage) is on the account this chat runs against. Account-level, not chat-level. Absent until a reading exists — a blank bar would read as zero usage. Clicking it opens the usage popover (the composer's context ring opens the same one). Shown for every chat including special threads.

- Action icons — far right: icon-only buttons, each with a hover tooltip. Editor and Archive are direct icons; the rest sit behind a `⋯` overflow menu, so the icons reached for every day are not competing with a long rail:
  - Editor — toggles the chat's Files tab (§ Editor — two surfaces § File browser): open/focus it if it isn't already the active tab, close it if it is — the same toggle `⌥ E` runs (§ Panes and tabs § Keyboard). The diff editor is still reached directly — a tool-call click in the stream, or `⌘'` — without going through this button. Shown for every chat including special threads.
  - Archive / unarchive — toggles `archived` (`04-chats-and-folders.md` § Lifecycle); the tooltip carries `⌘ ⌥ A`. This is the header's default way to clear a chat you are finished with. While the chat is archived the icon reads as active and names Unarchive. Regular chats only.
  - More (a `⋯` button) — opens an anchored menu, dismissing on click-off and Esc like every other anchored pop-up. For a regular chat it holds, in order: Tools (a wrench — opens the Tools sidebar for this chat, § Tools panel), Snooze (a clock icon and the word, the whole row one button — opens the preset pop-up described below), Move to… (a dialog: machine, then folder there — `04-chats-and-folders.md` § Moving a chat to another host), and Delete (danger colour) last: a recoverable soft-delete (the chat moves to the sidebar's Deleted section and can be restored), not a permanent removal. For a special thread, which has no Archive/Snooze/Move/Delete, it holds Tools, Disable / Enable (`06-threads-manager-speakers.md` § Disabled) and Clear context (`06-threads-manager-speakers.md` § Session rotation) instead — so it stays the one door to Tools even where none of the other items apply.
  - Snooze preset pop-up (opened from the `⋯` menu's Snooze item): `2 minutes`, `5 minutes`, `30 minutes`, `1 hour`, `1 day`, `Next week`, and `Custom…` (a `datetime-local` field + `Snooze`). Choosing one resolves `now + delta` to an absolute timestamp and snoozes the chat (`04-chats-and-folders.md` § Snooze); the chat leaves the active list for the sidebar's Snoozed section. While the chat is snoozed the item reads `Unsnooze` first. The pop-up dismisses on click-off and Esc like every other anchored pop-up.
  - Threads (a fork icon) — opens the side threads panel on this chat's most recently active side thread (§ Side threads panel). Absent until the chat actually has one; an empty panel with nothing to pick from is a dead end.

As the panel narrows the name is the only zone that gives way: it truncates with an ellipsis and, consistent with its own no-tooltip rule above, gains no hover tooltip even then — the one place in the app the general clipped-text tooltip rule (§ Copy) is deliberately not applied, since the full name is one click away (the rename field shows it in full, selected). Back / Forward stay visible however tight the space. The action icons keep their size too: once the action row's own width can't fit every icon cleanly, the individual icons are replaced with a single menu button (§ Layout (desktop) → Narrow widths) opening a dropdown listing every action above by name (Editor, Threads, Archive/Unarchive, Tools, Snooze, Move to…, Delete, or for a special thread Editor, Threads, Tools, Disable/Enable, Clear context), rather than shrinking the icons or widening the header. The dropdown dismisses on click-off and Esc like every other anchored pop-up.

Removed from this header entirely: New chat (the sidebar's own `+ New chat` and `⌘ N` / `⌘ ⇧ N` remain the way to start one), Pin (still reachable from the sidebar row's right-click menu, § Row context menu), and Call (moved to the composer, § Composer — the composer's own mic already sits next to attach, and call is the same family of action).

Voice is initiated per-chat from the row's mic button (tap-and-hold) for one-shot voice notes, or from the composer's Call button for a sustained voice call (`07-voice-app.md`).

## Routes

| Route              | View                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/chats/:chatId`   | Chat detail (default view for "new message received")                                                                                                                                                                                |
| `/jobs`            | Job list with search                                                                                                                                                                                                                 |
| `/jobs/:id`        | Job editor (form + raw JSON tab)                                                                                                                                                                                                     |
| `/jobs/new`        | New job flow (wizard: pick trigger → filter → action)                                                                                                                                                                                |
| `/lifecycle/:kind` | Main-window view of one cold-storage section (`hidden` \| `archived` \| `snoozed` \| `deleted` \| `automations`), reached from the sidebar icon row's "Open in main window" link (§ Sidebar item 6)                                  |
| `/settings`        | Build (connected origin + server SHA), account, linked devices, push tokens, shared settings (`01-server.md` § Settings), hosts (per-host status, settings version, components, folders, Claude Code memory and drift) + add-host QR |
| `/sidebar-window`  | The sidebar alone, no pane area — only reached by opening the sidebar in a new window (§ New windows)                                                                                                                                |
| `/tab-window`      | One detached tab (any kind) — only reached by "Open in new window" on a tab (§ Panes and tabs § Opening things, § New windows)                                                                                                       |

`/chats/:chatId`, `/jobs`, `/jobs/:id` and `/settings` are each a thin bridge into the pane/tab tree (§ Panes and tabs) rather than a route that renders its own view directly: visiting one opens (or focuses) the matching tab in the active pane, same as any other navigation, so the pane/tab tree — not these routes — is what a reload actually restores. `/jobs` and `/jobs/:id` still carry their own address because each names a distinct job; `/settings` does not — there is only ever one Settings tab (its `tabKey` doesn't vary by sub-page), so which of its own pages is on screen is that tab's own internal state, the same as a file tab's diff toggle, rather than a nested route. A link elsewhere in the app that wants Settings on a specific page (`/settings/<page>`, e.g. the out-of-usage banner's Usage link) still works as a deep link — it opens the Settings tab seeded on that page — but switching pages once the tab is already open does not move the address bar, and reloading mid-session no longer bookmarks the page you were last on: a deliberate trade against the old per-page URL, in exchange for behaving like every other tab's own internal nav. Going back out of a page reached this way (its own `←`/Back) returns to wherever the deep link was clicked FROM — the chat, say — not to the Settings list, since the user never asked to see the list; going back from a page reached by drilling in from the list (clicked a nav row with Settings already open) returns to the list, since that is where the user actually came from (§ Layout — desktop: "A page's own Back control returns to the page the user was on before it").

### `/settings` details

The Settings page is a compact list of titled sections, each showing only
its title, live value, and its control(s) — no explanatory prose. The user
reads the state, not paragraphs about it.

Where a setting is an editable value on the same line as its name, the value is
drawn as a field: a bordered, padded box separated from the name by a clear gap,
so the line reads as a name and a value rather than as one run-together string.
A field is never narrower than the content it holds — a picker shows its whole
option label at any window width — so no value is shown truncated.

Sections are grouped into six groups, in this order: Account & connection,
Agent behavior, Voice, Credit sources, Hosts & devices, Special
threads. Within a group, sections appear in the order below.

#### Account & connection

- Account — the account id (one Ed25519 key = one account, `10-auth.md` §
  Identity layers).
- Connection — server origin this surface is connected to + that server's git
  SHA (`GET /api/healthz`), so a stale packaged app can't masquerade as current.
  (No Appearance/theme control — the theme always follows the OS; see § Theming.)
- Remote access — shown only on a server that has a relay (`10-auth.md` §
  Relay): whether devices can reach it through the relay right now, and how many
  are connected; when the relay cannot be reached, why.
- Version — the surface's own build (§ Live updates).
- This surface — a single Deactivate surface action. There is no
  "Log out" / "Sign out" anywhere in Patch: a surface is linked to the
  account, not logged in to it, so the only thing leaving can mean is un-linking
  this device — the same operation the Linked-devices list calls revoke
  on the others. It is not reversible by signing back in; the credential is gone
  and the surface must be paired again by QR.
  The action is destructive and therefore confirmed: it opens the app's
  confirm dialog (the app's own, not `window.confirm`) which names the consequence — this
  surface is revoked and must be re-paired to be used again — with a
  Deactivate danger button and Cancel. Cancelling does nothing at all:
  no revoke request is sent, the local credential is untouched, and the app does
  not reload. On confirm the surface self-revokes on the server
  (`POST /api/auth/revoke` with its own surface id), clears the local
  credential, and reloads into pairing; a failed revoke still clears locally and
  surfaces the error, so the user sees what actually happened.

#### Agent behavior

Bare Claude Code, plus the layers patch adds on top of it — one row per layer,
each independently toggleable with a stated default. Every row is a shared
setting that applies on every host (`01-server.md` § Settings).

- CLAUDE.md — on by default. Governs whether the shipped, user-editable
  CLAUDE.md for the Manager/Speakers threads
  (`06-threads-manager-speakers.md`) is loaded for chats on those
  threads. Off excludes that file from loading for the turn without touching
  the file itself, so turning it back on restores exactly what was there.
- Patch tools prompt — on by default, showing the built-in guidance
  (`toolsPrompt.ts`) as editable text; an edit replaces it, and clearing the
  field turns it off. Appended to whichever system prompt is in force rather
  than replacing it. A Reset to default control returns to the built-in text
  and is disabled while the field already matches it.
- Memory — off by default. Governs Claude Code's own persistent memory (the
  auto-memory directory it reads from and writes to for the turn). Off means
  Claude neither reads from nor writes to it.
- System prompt override — off by default (empty). When non-empty, replaces
  the SDK's default system prompt entirely rather than appending to it.
- Skills — off by default (empty, meaning no explicit configuration). A
  comma-separated list of skill names to enable for every chat, or `all` to
  enable every discovered skill.
- Browser tools — off by default. Governs whether the `playwright` and
  `chrome-devtools` MCP servers are wired into chats, alongside
  `patch`'s own tools. Most chats never need them; a chat that does turns this
  on rather than every chat paying for two extra MCP processes it never calls.
- Default model — the model every new chat starts on, account-wide, unless it
  names its own: opened from a surface, fired by a job, or started on a
  machine. One decision, in one place, read from whichever host is the
  account's home host (`06-threads-manager-speakers.md`); a saved
  value not in that host's model catalogue is still offered as an option, so a
  catalogue that changed can never unpin it.
- Default permission mode — the mode new chats are stamped with, chosen from
  the modes the backends accept (`00-overview.md` § Permission model).
- Questions — whether an unanswered question expires, and the window in
  seconds it is given (`02-daemon.md` § Questions are not approvals).
- Auto-resume — retry a turn blocked by a usage/rate limit automatically once
  the window resets, rather than waiting for the user to retry it.
- Chat names — how many user messages between regenerating a chat's name,
  where 0 leaves the name as first set.
- Claude Code settings — the shared `settings.json` as raw text, and beneath it
  one override box per OS (`02-daemon.md` § Claude Code settings), each a
  multi-line monospace editing box with a Save control directly beneath it. An
  empty box still shows at its full height with an empty-object placeholder
  inside, so the section never collapses to a heading and a lone Save. A box is
  sized by the text it holds: it grows with the content up to half the window
  height, past which it scrolls within itself, never shrinks below several
  lines, and can be dragged taller. It takes the full width of the settings
  column, because a narrow box wraps the indented lines this file is made of.
- Provider-level context — `providerContextVerbosity` (`02-daemon.md` §
  Provider-level context); a three-step control (Off / Summary / Full)
  setting the default expand state of `ProviderContextPanel`. Summary by
  default, matching the panel's pre-existing collapsed-row behaviour. Does not
  affect the `<system-reminder>` disclosures, which are not account-configurable
  and stay collapsed-always.

#### Hooks

Its own page (`20-hooks.md`), the same shape as Settings → Keys: a list of
every configured hook — name, `when`, kind (script/prompt), enabled switch —
each opening an editor (name, kind and its fields, gate, timeout) with Save
and a destructive, confirmed Delete. Add opens the same editor blank. Nothing
is preinstalled, so the list's empty state says so rather than showing
nothing with no explanation.

#### Goals

Its own page, between Manager and Voice in the Agents group (`04-chats-and-folders.md` § Goals). Three rows, account-wide, each applied by every host on its next judgement: the judge model (the one model that judges every chat's goal, whichever provider the chat runs on, default Sonnet 5.5), how many refusals in a row end a goal's pushing (default 3), and the judge prompt. The prompt is the judge's instructions only: the host adds the goal, the conversation and the reply format around it, so an edit cannot break how the answer is read. It opens in the same editor as the sweep prompt, showing the full default, with a Reset to default.

#### Jobs

Its own page, between Hooks and Hosts in the Agents group. One row, "Autonomy prompt": the text every job's first user-turn is prefaced with unless that job overrides it (`08-triggers-and-jobs.md` § Autonomy prompt). It opens in the same editor as the Manager's sweep prompt (Save, Cancel, ⌘↵), and Reset writes the built-in default back. It is the only place the account-wide prompt is edited; the job editor shows it only under a collapsed Advanced area.

#### Voice

The Kokoro voice, picked from the Kokoro voices (`07-voice-app.md` § Kokoro),
and the per-surface voice config: for each of Dictation, Voice device, Hands-free and
Call, which backend handles it (`local`, `gemini` or `openai`) and, for the
three conversational surfaces, which front layer sits in front of the agent
(`07-voice-app.md` § Voice is a config matrix). Every combination is
selectable; a cell that is refused, or that runs as something other than its
name (a hosted `direct` runs as `light`; Gemini hands-free does not apply the
address word), says so honestly rather than being blocked. A hosted cell whose key a
host lacks names that host and the key; the line clears as soon as the host
reports the key, which Settings → Keys sets without a restart.

#### Credit sources

- Claude — the shared Claude accounts, in order (`10-auth.md` § Backend
  credentials), one row per account with its usage bars — the freshest reading
  any host has taken, naming that host — and the strategy that picks among
  them as a row of pills (Priority, Round robin, Soonest reset, Least used). An
  Add another account control. Beneath the list, one Adopt control per host that has a
  Claude login of its own not already stored, naming the host.
- OpenAI — the shared OpenAI/Codex accounts, on the same terms as Claude above.
- Keys — the provider keys (`02-daemon.md` § Provider keys): Gemini, OpenAI
  Realtime and Groq, one row each, stating where the value in use comes from —
  _Set from UI_, _Set from environment_ (naming the hosts) or _Not set_ — with
  its last four characters. Add / Replace opens a write-only password field
  with Save and Cancel; Revoke, on a UI-set key only, asks first. A key only a
  host's environment supplies offers Adopt instead of Revoke. The value is
  never shown back.

#### Hosts & devices

- Hosts — one row per host machine (`02-daemon.md` § Host identity). Each row
  shows the host name (editable inline), online/offline with last heartbeat,
  platform, host version with an Update control when one is available, and the
  host's agent backends (version per backend, and whether its check of the
  shared accounts passes, `10-auth.md` § Backend credentials), and the settings version it is running with, or why it
  refused the latest one (`01-server.md` § Settings). Expanding a row gives
  that host's:
  - Permission overrides — how many of the host's chats carry a mode of their
    own, set in the chat's own approval-mode control (§ Composer).
  - Components — the optional downloads (`02-daemon.md` § Optional
    components), each with size, state, and an install/remove control, showing
    live progress while downloading.
  - Project folders — that host's launch folders, offered by the new-chat
    picker under its name (`04-chats-and-folders.md` § Folders). The list is
    editable here: each row carries a remove control, and an add control takes a
    path on that host, both writing through to that host
    (`03-wire-protocol.md` § Host events) and settling when its
    `folders.updated` arrives. A path the host does not have is reported as
    that, and an edit aimed at an offline host is refused up front naming it.
  - Claude Code — that host's memory entries, each showing name, type and
    description with a remove control, a debugging view of the raw files on
    that machine distinct from the Memory switch in Agent behavior. When that
    host's `settings.json` has drifted (`02-daemon.md` § Claude Code settings),
    the changed text, with Keep as shared, Keep for this OS and Discard. Remove
    and discard write through to that host and settle when its
    `claude_settings.updated` arrives; aimed at an offline host they are
    refused up front naming it.
  - Browser — Route through: None, or any OTHER registered host (never this
    one), picking which network this host's `patch_browser_*` traffic
    egresses from (`02-daemon.md` § Route through). Written through to that
    host on the same terms as Voice above. While it names a host,
    this row states "via &lt;host&gt;"; if that host is offline, the row says
    so plainly, naming it, since browsing from here will fail until it
    reconnects.
  - Home host — marks this host as the account's home host, where Manager
    and Speakers run (`06-threads-manager-speakers.md`).
    Exactly one host carries it; setting it on another moves the threads.
  - Remove host — confirmed, naming how many chats live on it
    (`10-auth.md` § Revocation).

  Above the list, Add host asks the server for a daemon-registration nonce
  (`10-auth.md` § Host registration) and shows it as a QR and a short code,
  with the one-line install command for the target OS (`02-daemon.md`
  § Installation); the installer on the new machine is what redeems it, and the
  screen resolves when that host registers. On the desktop app, a machine with
  no host also offers Run a host on this Mac, which installs the OS service
  and hands it a nonce fetched the same way (`02-daemon.md` § Desktop app and
  the local host).

- Linked devices — the surfaces on the account, each revocable, with a
  Link a device QR (`POST /api/auth/pair/start`; `10-auth.md` § Surface
  linking) drawing the code the server issued — its public address, or its
  relay (`05-surfaces.md` § Canonical QR payload). Available from any surface. The registered Android-device count is
  a value in this section rather than a section of its own: push registration
  belongs to the surfaces it is about, not to a heading stating a bare number.
  No register control on web/desktop (registering here can't work); a real
  register action appears only on the phone surface.
- Voice devices — the account's registered voice-device satellites
  (`16-voice-device.md`), each revocable on the same terms as a linked device.

#### Special threads

- **Sweep** (`06-threads-manager-speakers.md` § The sweep) — an Enabled
  switch (on by default); the interval (minutes, default 30); the stalled
  threshold (minutes of no new output before a running chat counts as stalled,
  default 15); messages per chat (how many of each changed chat's recent
  messages go into the digest, default 3); the model the sweep's one decision
  call runs on (default a mid-size model); and the sweep prompt — a text field
  showing the full default, editable, with a Reset to default (same pattern as
  the Patch tools prompt, § Agent behavior above). Account-wide, not
  per-surface: the sweep runs on the server and the home host.
- **Manager** — the quiet hours during which no sweep flag is delivered, the
  context window (how many of the Manager's own messages the model sees,
  default 40 — § Manager conversation — bounded context), and the address word
  that makes a spoken utterance a turn while a session is in `hands-free`
  (`07-voice-app.md` § Session modes), defaulting to `patch`.
- Manager & Speakers — the model those two threads run on
  (separate from the account's default model above, since these are always-on
  threads rather than ad-hoc spawns), and scheduled session rotation: a switch,
  a time of day, and the rotation itself, which retires each thread's session
  and starts a fresh one seeded with a handoff digest rather than waiting for
  auto-compaction to fire on its own (`06-threads-manager-speakers.md`
  § Session rotation).

## Startup cost

The entry bundle carries only what first paint needs. Every surface — including a phone on a slow link, and including the shell reloading itself after each deploy (§ Live updates) — downloads, parses and evaluates the entry chunk before the first chat can render. Anything statically imported from the app entry is in that chunk whether or not it is ever used.

The rule: a feature the UI already defers must not be loaded eagerly. Concretely, the Monaco file editor — the editor itself, its language tokenizers and its language services, several megabytes and the single heaviest dependency — loads on demand, when an editor surface first mounts, rather than from the entry. That includes its self-hosting bootstrap (the module that installs the worker resolver and hands the bundled editor to the loader so nothing is fetched from a CDN — see § Editor): it is pulled in on the same deferred path as the editor components, and awaited before them, so the wiring is always in place by the time an editor initialises. The cost of opening a file is therefore paid by the session that opens a file; the (normal) session that only chats does not pay it.

The trade is deliberate: the first editor open is marginally slower for the session that opens a file, and cold start is faster for everyone on every load.

Guarded by a test that walks the entry's static import graph and fails if anything on the deny-list is reachable.

## Live updates

The app keeps itself current — a new deploy lands without any manual reload, pushed over the existing WS, not polled. The server reports the content hash of the web bundle it serves (`assets/index-<hash>.js`) on `auth.ok` — the frame every surface receives on (re)connect. Because every deploy restarts the server, the surface's WS drops and reconnects right after a deploy, and that reconnect delivers the new hash. If it differs from the bundle the surface booted from, it reloads itself immediately — a plain `location.reload()`, which fetches the no-store HTML (see `11-deployment.md`) and with it the new bundle. No force-reload, no cache-busting query string, no polling timer.

The one hold: it does not reload mid voice call / note (that would drop live audio) — it defers and reloads the moment the session ends. In the dev harness there is no hashed bundle, so it is inert.

## Notifications

There is no in-app notifications drawer. A notify's canonical record is the `patch_notify` tool-call in its source chat's history; the sidebar shows what needs attention now (`!` for input needed, `·` for new activity). Notifications are ephemeral (see `09-notifications.md` § Notifications are ephemeral).

## Keyboard shortcuts

| Shortcut         | Action                                                                                                                                                                                            | Scope                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `⌘ ?`            | Open the keyboard-shortcuts viewer (this table, rendered as a modal cheat-sheet)                                                                                                                  | Anywhere                           |
| `⌘ K`            | Focus the page's search field (§ Reserved OS chords)                                                                                                                                              | Anywhere                           |
| `⌘ F`            | Focus the page's search field (§ Reserved OS chords)                                                                                                                                              | Page with a search field           |
| `⌘ /`            | Toggle sidebar (same as the brand-row `‹` chevron / the collapsed state's `›` chevron)                                                                                                            | Anywhere                           |
| `⌘ W`            | Close the active pane's active tab (§ Panes and tabs)                                                                                                                                             | Anywhere                           |
| `⌘ N`            | New chat in the current or most-recently-used (host, folder) pair                                                                                                                                 | Anywhere                           |
| `⌘ ⇧ N`          | New chat with folder picker                                                                                                                                                                       | Anywhere                           |
| `⌘ ↑ / ⌘ ↓`      | Prev / next chat in sidebar. In the composer specifically (a chat opens with the cursor there), the bare chord still does this instead of moving the caret — § Discoverability                    | Chat view                          |
| `⌘ ⇧ ↑ / ⌘ ⇧ ↓`  | Jump to prev / next folder section                                                                                                                                                                | Chat view                          |
| `⌘ 1`            | Jump to Manager                                                                                                                                                                                   | Chat view                          |
| `⌘ 2`            | Toggle Channels (expand/collapse)                                                                                                                                                                 | Chat view                          |
| `⌘ ← / ⌘ →`      | Back / Forward through the main panel's navigation history (§ Chat panel header)                                                                                                                  | Chat panel shown, no field focused |
| `⌘ ⌥ A`          | Archive current chat                                                                                                                                                                              | Chat view                          |
| `⌘ ⇧ A`          | Toggle archived view                                                                                                                                                                              | Chat view                          |
| `⌘ J`            | Jump to oldest unread chat                                                                                                                                                                        | Chat view                          |
| `⌘ ⌥ ← / ⌘ ⌥ →`  | Previous / next tab in the active pane (§ Panes and tabs), wrapping at the ends. Reads past a focused text field — see that section's own § Keyboard                                              | Chat view                          |
| `⌘ \`            | Split the active pane, moving its active tab into the new one (§ Panes and tabs). Reads past a focused text field                                                                                 | Chat view                          |
| `` ⌃ ` ``        | Toggle the chat's Terminal tab (§ Terminal, § Panes and tabs)                                                                                                                                     | Chat focused                       |
| `⌥ E`            | Toggle the chat's Files tab (§ Editor — two surfaces § File browser, § Panes and tabs)                                                                                                            | Chat view                          |
| `⌘ P`            | Go-to-file (in chat's folder)                                                                                                                                                                     | Editor open                        |
| `⌘ S`            | Save the open file (§ Editor)                                                                                                                                                                     | Editor showing a file              |
| `⌘ '`            | Open diff for the last agent edit, as that file's tab (§ Diff editor)                                                                                                                             | Chat focused                       |
| `⌘ ⇧ '`          | Open the chat's Files tab (does not close it if already open — unlike `⌥ E`, a dedicated open)                                                                                                    | Chat focused                       |
| `↵`              | Send composer. While the chat is running, this QUEUES the turn behind the in-flight one. In an EMPTY composer, promotes the queued message instead (`04-chats-and-folders.md` § Message queueing) | Composer focused                   |
| `⌘ ↵`            | Send and promote: sends, then interrupts the running turn so the queue drains now. In an empty composer, promotes the queued message (`04-chats-and-folders.md` § Message queueing)               | Composer focused                   |
| `⌘ ↵`            | Save / commit the field being typed in                                                                                                                                                            | Editable field with a save action  |
| `⇧ ↵`            | Newline in composer                                                                                                                                                                               | Composer focused                   |
| `Esc`            | Stop / interrupt the running turn                                                                                                                                                                 | Composer focused + chat running    |
| `⌘ ;` (hold)     | Voice note to current chat (PTT)                                                                                                                                                                  | Chat focused                       |
| `⌃ Space` (hold) | Voice note to Manager (global, OS-wide)                                                                                                                                                           | Menu-bar surface                   |
| `⌃ ⇧ Space`      | Toggle voice call with Manager (global)                                                                                                                                                           | Menu-bar surface                   |
| `1` / `2` / `3`  | Approve / approve all outstanding / decline (permission card; NOT a question card — see § Main chat panel)                                                                                        | Permission shown                   |
| `↵`              | Accept incoming call                                                                                                                                                                              | Incoming-call banner               |
| `Esc`            | Dismiss incoming call · cancel voice note                                                                                                                                                         | Context-dependent                  |

`⌘ ↵` is not a composer key with a special case elsewhere; it is the app's commit
key. Every field that has a save or commit action takes it — the message editor,
a job's fields, a host's prompts and settings, the file editor, the sign-in
paste box — and it runs exactly what that field's own save control runs, so a
save the control is not offering the chord cannot force either. `⇧↵` is a
newline everywhere, and a field mid-IME-composition keeps `↵` for its candidate.

Scope is not a label, it is enforced: outside the Scope column's place, the key
does its normal OS/browser thing instead. A chord scoped Chat view fires only on
a chat, new chat, or the empty "no chat open" state, and does nothing on Jobs,
the job editor, Settings, or the file editor. A text field keeps its native keys
even inside a Chat view chord's scope — a job's prompt, a settings field, a
search box — with two exceptions: the bare (no-shift) `⌘ ↑ / ⌘ ↓` still switches
chats from inside the composer specifically, since a chat opens with the cursor
already there and that is how keyboard switching is reached at all; and the
panes-and-tabs chords (`⌘ ⌥ ← / ⌘ ⌥ →`, `⌘ \`, `⌥ E`, `` ⌃ ` ``, `⌘ ⇧ '`, and
`⌘ W` — the latter scoped Anywhere, not Chat view — § Panes and tabs §
Keyboard) read past any field, since none of them collides with a field's own
keys.

### Reserved OS chords

The app leaves the platform text-editing chords unbound: `⌘ A` (select all), `⌘ C` / `⌘ X` / `⌘ V`, `⌘ Z` / `⌘ ⇧ Z`. These reach the browser/OS untouched everywhere — inside the composer AND over the transcript, where `⌘ A` selects the whole conversation so it can be copied. No app action may `preventDefault()` them, and "the focus isn't in a text field" is not a licence to reuse them: selecting the transcript is exactly what the user means by `⌘ A` there. Archive therefore sits on `⌘ ⌥ A`, not `⌘ A`.

`⌘ F` is reserved the same way, with one carve-out: on a view that has its own search field, `⌘ F` focuses and selects that field instead of opening the browser's find bar. Find-in-page is what the chord means, and a page carrying a search field already answers it better than the browser can. Where the view has no search field the chord is left alone and the browser's find bar opens as normal. The chat view is the exception: `⌘ F` there opens find-in-chat (§ Find in chat), because the desktop shell has no find bar of its own. A view opts in by marking its search field, not by naming a route, so a field added later carries the chord with it; `⌘ K` resolves to the same field. The sidebar's chat search is the exception: it is on screen over every view, so it takes `⌘ K` only — `⌘ F` skipping it is what lets the chat's own find bar take that chord — and `⌘ K` prefers any field of the view's own. When more than one marked field is on screen, the one in the main content area wins over the ones in the sidebar, and a field that is not on screen is skipped.

### Find in chat

`⌘ F` over a chat opens a small bar at the top right of the chat, over the transcript, with one input, a `n/total` count, previous / next buttons and a close button. Typing highlights every case-insensitive match in the rendered transcript and the first is scrolled to the middle of the view, shown in a stronger colour than the rest. `Enter` / `⇧ Enter` step to the next / previous match, wrapping. `Esc` or the close button closes the bar, clears the query and removes all highlights. A match is within one run of text; a phrase broken by inline formatting is not matched. The bar is per chat and closes on switching chat. It paints with the CSS Custom Highlight API and does not fall back if the engine lacks it.

### Discoverability

Shortcuts are shown around the app, not hidden in a settings dialog. Concretely:

- `⌘ ?` opens a modal cheat-sheet rendering this table, grouped by context. Always available.
- A button with a visible text label displays its shortcut in a small monospace tag right of the label, e.g. Save `⌘↵`, Send answer `⌘↵`. The tag is set back from the label by being smaller, and takes the button's own ink rather than a colour of its own — the same tag has to stay legible on an accent fill and on a plain surface. The sidebar's `+ New chat` button is the one exception: its `⌘N` is tooltip-only, not tagged, so the button's own label stays the shortest possible call to action.
- Hover tooltips also include the shortcut, formatted the same way.
- Permission cards show `1` / `2` / `3` next to each option.
- The composer placeholder is bare — `Type a message`, and nothing else. It is an empty field's prompt, not a teaching surface: the send convention is carried by the send button's own tooltip (`Send (↵)`) and the cheat-sheet, per § Copy — no helper text. An offline composer swaps it for `Reconnecting…`, which is state, not instruction.

A power user shouldn't have to dig for the shortcut; a new user learns them passively by seeing them next to actions they already know how to click.

The shortcuts above are global to the SPA and are written once, in macOS glyphs. Every surface that draws a chord — cheat-sheet, tag, tooltip — renders it for the keyboard in front of the user, from that one definition: a Mac gets the glyphs, and anything else gets the words its keys are printed with, joined with `+` (`Ctrl+Alt+A`, `Alt+E`, `Ctrl+Enter`). Swapping one Apple glyph for another off a Mac would still name a key that keyboard does not have. The underlying chord is unchanged either way. Configurable in Settings → Keyboard.

## Jobs view

Reference mock: `design/web-lo-fi-schedules.html`.

Data-forward. Most jobs are created by the agent (it calls `patch_job_create`); the user rarely opens this page. The page exposes the underlying data directly:

- The list shows trigger as natural-language ("weekdays at 8:57am", "every 30 minutes between 7am and 10pm", "Todoist task tagged @claude") for scannability, cron schedules being labelled by the shared describer (`08-triggers-and-jobs.md` § Cron) and falling back to `cron · <expression>` for a shape it cannot phrase, and action as the verb (`SKILL` / `PROMPT` / `MESSAGE`) plus its target. A folder-addressed target reads as its host name and folder together, so the same path on two hosts reads as two different jobs. The inline `runs` panel names the host each fire was dispatched to and shows a fire waiting on an offline host as pending against it.
- A cron trigger's label names the zone it runs in — "weekdays at 9am · UTC" — whenever that zone is not the reader's own, and omits it when they match. A schedule read in its own zone needs no qualifier, and a label on every row would be noise; without one, a job in another zone (including one carrying no zone, which runs in UTC — `08-triggers-and-jobs.md` § Cron) reads as the reader's own 9am and is wrong by an hour. The zone is part of the label, so the search field matches it like any other part of the row.
- A search field in the page header narrows the list as you type, matching case-insensitively against the job name, the natural-language trigger label and the action verb and target. It matches what the row shows and nothing hidden behind it, so a result is always visibly a result. One field covers what would otherwise be separate filters: typing "webhook" or "todoist" narrows to a trigger type, and a skill name finds the jobs that run it. It is drawn only when there are jobs to search. A query that matches nothing says so on its own row and keeps the field in place; the empty-jobs graphic is reserved for genuinely having no jobs, and would otherwise read as the list having been emptied.
- Beside the search field the header carries a sort control and two filter controls, drawn under the same condition as the search. Sort orders the rows within every section by last fired (most recent first, jobs that have never fired last), by name, or by when the job was created (newest first); it never changes which sections are drawn or the order they appear in. The default is last fired: the page is read to see whether the automations are still running, and the freshest fire is the top of that answer. The filters narrow on status (any / enabled / disabled) and on trigger type (any / cron / webhook / todoist), which is the narrowing the free-text field cannot express — it matches what a row shows, and a row does not show whether a disabled job was disabled. Each control is labelled by its own default option; none carries a caption. Sort and both filter axes are per-user state held for the session, like the section fold states.
- The filters and the search compose: a row survives only if it satisfies every one of them. A combination that matches nothing shows the same no-matches row a query alone does, naming whichever narrowed the list — the query, quoted; the filter; or both.
- Each job on the list carries its most recent fire — when it fired, how it ended, and the chat it landed in — so the page draws a last-fired per row and links a spawn job to its latest chat from the one list request rather than a request per row. The list refreshes on an interval, since a last-fired is live state. A job that has never fired reads as never.
- A job holding fires behind its concurrency limit (`08-triggers-and-jobs.md` § Concurrency) reads as "N queued" on its row. A job with nothing waiting shows nothing — the backlog is the only thing worth surfacing.
- The list is grouped into four sections under their own headers, in order: the recurring jobs, the one-off jobs still waiting to fire, the expired ones (`08-triggers-and-jobs.md` § One-off jobs), then the archived ones (`08-triggers-and-jobs.md` § Archived jobs). A section with nothing in it is not drawn at all, so an installation with no one-off and no archived jobs shows a single ungrouped list exactly as it would with no grouping. The first two sections are always open; expired and archived are each collapsed by default with the count on their own header, because both are kept for what they hold and would otherwise crowd out the jobs that still run. Whether each is open is per-user state held for the session.
- Within each of those four sections, jobs sub-divide further by the user's own free-text `group` (`08-triggers-and-jobs.md` § Groups) — a plain heading per group, in the order each group's jobs first appear in the (already sorted) section, with the ungrouped jobs trailing last under their own heading. This only draws when a section actually holds more than one distinct group; a section that is entirely one group, or entirely ungrouped, stays the plain list it always was. Unlike the four status sections these headings never collapse — there is nothing here to hide, only to label.
- An expired or archived row is muted and its enable switch is dead. Neither job fires, so a switch offering to run it would lie about what it does (`08-triggers-and-jobs.md` § One-off jobs, § Archived jobs). An expired job is brought back from the editor; an archived one from its own row.
- Each row carries a Run now control that fires the job once, immediately (`08-triggers-and-jobs.md` § Manual run), without opening the editor first. On success the app navigates to that job's editor (`/jobs/:id`), where its runs panel shows the fire. It works on a disabled, expired or archived job, as the editor's does; it is dead while its own request is in flight, and a failure surfaces as a `run now failed` error toast. There is no success toast — arriving on the job is the confirmation; on failure the user stays on the list.
- Each row carries an archive control and a delete control, so a job can be got rid of from the list it is cluttering rather than only from inside the editor. Archive puts the job away and moves it to the archived section, where the same control reads Unarchive and brings it back to the section it came from. Delete is permanent and asks for confirmation first — the same confirmation the editor's Delete asks for.
- Search spans every group, and the grouping applies to what the query matched — a query that hits only expired jobs draws that section alone, still collapsed and carrying its count, rather than reading as no match.
- The editor's header names the job's end condition when it has one (`08-triggers-and-jobs.md` § One-off jobs) — a small chip reading "One-off" beside the title for a job carrying `oneOff`, and a second "Expired" chip when it has already retired (`expiredAt` set). Both are read-only: there is no editable control for either field on this page, the same treatment the Queue panel gives the concurrency limit (`08-triggers-and-jobs.md` § Concurrency) — set through the agent tools, shown here so a human opening the job can see why its Toggle is dead without going to the list's own grouping first. An ordinary recurring job, and a brand-new one not yet saved, show neither.
- The editor is one form view (no JSON tab, no wizard) — all groups (Trigger / Filter / Action) visible at once on a single page; inputs are white on the white panel.
  - Autonomy prompt (`08-triggers-and-jobs.md` § Autonomy prompt) sits first on the page, above Trigger — it applies to the whole job rather than to any one trigger or action. A box holds the text, pre-filled with the default and disabled, beside a Customise toggle; ticking it enables the box for editing (seeded from the default text if it was empty) and unticking it disables the box again without discarding what was typed, the same kept-while-off treatment the gate command gets. A new job is unticked. Saving unticked writes no override — the job reads back on the default; saving ticked with empty or unchanged-default text does the same.
  - Group is an optional dropdown beside Name (`08-triggers-and-jobs.md` § Groups) — what the list's group headings read. Options are every distinct group already in use across the user's jobs, alphabetical, plus a trailing New group… option that reveals a free-text input for a name not yet in use. Empty/no selection means ungrouped. A job already saved against a group no other job carries any more still shows that one, as the dropdown's own extra option, the same treatment Folder gives a saved path the picker no longer offers.
  - Trigger type select + natural-language config (the agent generated this at creation time; humans rarely edit).
  - For a cron trigger there is a single natural-language Schedule field — "every weekday at 9am", "every 15 minutes", "at noon", and time-windowed intervals like "every 5 minutes between 9am and 5pm" (→ `*/5 9-17 * * *`) or "every hour between 9am and 5pm on weekdays" (the window maps to a cron hour range, inclusive of the end hour). The computed cron is shown read-only beneath it (expression + the same natural-language label the list uses, falling back to the bare expression when the shape cannot be phrased); there is no second always-editable cron input. A small "edit cron directly" toggle reveals the raw 5-field cron for advanced cases, and it is auto-revealed when a phrase can't be parsed (the field says so rather than guessing).
  - A Timezone select beneath Schedule names the zone the expression runs in (`08-triggers-and-jobs.md` § Cron); it is listed alongside the computed cron. A new job defaults to the browser's zone; an existing job shows its stored zone, or UTC when it carries none.
  - Filter is shown only for payload-bearing triggers (webhook / todoist) — a cron trigger has no event to filter, it just fires, so the Filter group is hidden for cron and no filter is persisted for it.
  - Webhook config: `secret + scheme` (`none` / `hmac-sha256` / `github` / `stripe`).
  - JSONata filter shown raw — agent-generated, but visible for inspection. Humans don't typically edit; if they do, it's an advanced action.
  - Action — two axes: where (`spawn` a new chat each fire / `ensure` one persistent chat created once then reused / `message` an existing chat) and what (run a `skill` / run a `prompt`). Picking `ensure` shows the same folder picker as `spawn` plus a hint that the first fire creates the chat and later fires reuse it (`08-triggers-and-jobs.md` § Action).
  - Folder (for `spawn` and `ensure`) is the same host-grouped picker the new-chat flow uses (§8, `04-chats-and-folders.md` § Folders): under each host name, that host's configured project folders (Settings → Project folders) first, then folders seen in existing chats on it, plus a Custom path… option that reveals a free-text input for an ad-hoc path on that host. The folders-seen-in-chats half obeys the recent-folder selection rule (`04-chats-and-folders.md` § Folders), so patch's own special-thread working dirs and other non-project paths are never listed; a host's configured roots bypass it, as everywhere else. Picking a folder picks the host, and that pair is stored on the action as `daemonId` + `folder` (`08-triggers-and-jobs.md` § Action). A new job seeds the folder to the most-recently-used (host, folder) pair drawn from that same filtered set — never a special thread's folder, however recently that thread ran — the same seed the new-chat picker uses (§8), and to nothing at all when there is no such pair; a job already saved against a folder the picker would not offer still shows that folder, as the ad-hoc path it now is, rather than silently losing it; a `spawn` or `ensure` action saved with no folder or no host is blocked client-side with a clear message, matching the API's own rule (`08-triggers-and-jobs.md` § Action).
  - Model (for `spawn` and `ensure`) is a dropdown of the chosen host's live model catalogue — the same list `GET /api/models` serves the new-chat picker (§ Model selector) — reloaded when the chosen host changes and offering nothing until a host is chosen. Unlike that picker it leads with a `Host default` row, and a new job starts on it: a job is stored configuration that fires for months, so storing no model — leaving each fire to take whatever the host is currently last used on (`08-triggers-and-jobs.md` § Action) — is a distinct choice the user must be able to make and return to, where a new chat resolves the same thing once, at spawn. A saved model is always kept as an option even where the catalogue hasn't loaded, so editing an unrelated field never silently drops it. Not offered for `message`, which takes its model from the chat it delivers into.
  - Start on account (for `spawn` and `ensure`), under Model, when the model's backend has more than one account: `By strategy` first, then each shared account. A saved account the list no longer holds stays selectable, marked as not held, so an unrelated edit never drops it.
  - Recipient chat picker (for `message`).
  - Skill is a dropdown of the skills available in the action's target folder — its `.claude/skills/*` (for `spawn`/`ensure` the chosen folder on the chosen host; for `message` the recipient chat's folder on its own host). The list is fetched from `GET /api/skills?daemonId=&folder=`, which the server round-trips to that host (the host owns the project filesystem). An already-saved skill is always kept as an option even if the list hasn't loaded. An action carries a skill, a prompt, or both (`08-triggers-and-jobs.md` § Action).
  - Prompt is a multi-line field sized for what jobs actually carry — a prompt is often several paragraphs of instructions, so the box opens tall enough to read and edit one without scrolling a two-line slot, and can be dragged taller still. It resizes only vertically; widening it would break it out of the form column.
  - Permission mode (for `spawn` only) is a dropdown of the modes in `02-daemon.md` § Permission mode, labelled as in the composer's approval-mode control (§ Composer). Unlike Model it has no `Host default` row: a job runs unattended, so following the host would let someone changing their own machine's mode silently change how the job behaves (`08-triggers-and-jobs.md` § Action). A new job starts on Auto, which is also what a job storing no mode shows.
  - Hide chat from sidebar sets the action's `startHidden` flag, which puts each chat the job creates into Hidden (`08-triggers-and-jobs.md` § Action). It is a toggle, not a checkbox — the form has boolean fields and § Controls governs all of them, so the switch sits inline on one line with its label beside it, never stacked caption-above-input like the text fields around it. The label is the setting's name alone; what `startHidden` then does is the spec's business, not a caption's (§ Copy — no helper text). Drawn for `spawn` and `ensure`, the two actions that create a chat; `message` addresses an existing chat, so the control is not drawn for it at all rather than drawn dead.
  - Notify when job complete is the second such toggle, beside the first and following every rule above, and it is the one boolean on this form that starts ON: unticking it writes the action's `notifyOnComplete: false`, which stops the job's chats ringing the completion doorbell (`09-notifications.md` § Chat completion). Ticked is therefore the absent-field state, and unticking it is what writes something. Drawn for the same two actions as Hide chat from sidebar, for the same reason.
  - Include trigger event is the third toggle, following every rule above, and the second that starts ON: unticking it writes the action's `includePayload: false`, which stops the trigger's event JSON being appended after the prompt (`08-triggers-and-jobs.md` § Action). Ticked is the absent-field state. Drawn for all three chat-delivering actions (`spawn`, `ensure`, `message`) and not for `script`, which has no prompt. Mobile draws the same toggle.
  - A selected skill carries an Edit link beside the dropdown that opens the skill's own file in the file browser (§ File browser), putting what the job does one click from the job that does it. The skills list names the file each skill is defined in, so the link never guesses at a path. The browser is rooted at a chat's folder, so the link opens the file through a chat pinned to the action's own folder; where the action's folder has no chat yet, or the skill is a machine-wide one living outside that folder, the link is replaced by the reason it cannot be offered.
- Each row carries an open chat link to the chat the job runs in: for `ensure` its persistent `jobchat-<jobId>`, for `message` the target chatId, and for `spawn` the most-recent run's chat (a spawn makes a fresh chat each fire). Every run record stores the chatId it dispatched to, so each entry in the inline `runs` panel also links to its own chat — that's how the chats a job produced are reachable from the Jobs page.
- A job that has a concurrency limit (`08-triggers-and-jobs.md` § Concurrency) shows a Queue panel above the `runs` panel: the fires it is running now, each linking to its chat, then the fires waiting behind the limit in release order, each showing when it queued. A waiting fire has no chat yet, so it carries no link. The panel names the limit and refreshes on an interval, since it is live state rather than history. A job with no limit never queues anything and the panel is not drawn for it.
- Inline `runs` panel shows recent fires. For webhook triggers there's also a separate `webhooks` log accessible via the CLI (`patch jobs hooks <id>`) — every inbound, including filter-rejections — for debugging.
- The editor has its own Back control beside the page title (§ Layout (desktop)).
- The editor tracks whether the form differs from the job as it was last loaded or last saved. While it does, the page header carries an unsaved marker, drawn as the same small tinted chip the app uses elsewhere for something outstanding. Leaving the page then asks first, in the app's own confirm dialog (not `window.confirm`), offering to discard the changes or to stay and keep editing; staying leaves every field exactly as it was. This covers every route out the app offers — the back control, the sidebar, the history buttons and a destination sent by the desktop shell — and a window close asks through whatever the browser offers there. Only the user's own editing counts: loading the job, a background refetch of it, and the host/folder a new job seeds itself with are not edits and never raise the marker. A successful save clears it, so the save's own return to the list is never interrupted, and neither is a delete.
- Editing an existing job (not the new-job form) shows a Run now button beside Save/Delete (`08-triggers-and-jobs.md` § Manual run) — fires the action immediately, once, for trying it out without waiting for the real trigger or enabling the job first. The fire appears in the `runs` panel like any other, tagged `manual`; there is no separate success toast — the panel updating (it refetches on an interval) is the confirmation, and a dispatch failure surfaces the same inline error banner every other mutation on this page uses.

Most jobs are created by asking Manager. The form is the dashboard for inspection plus the occasional manual edit.

In-session reminders use `patch_wake_me` (see `08-triggers-and-jobs.md`); patch jobs are for cross-session, indefinite automations.

## Pairing screen

Shown when there's no stored surface credential. It takes one field, and what
the user pastes into it depends on which of the two routes in `10-auth.md` they
are on:

- The short pairing code from Link a device on an already-linked surface. This browser
  generates its own device keypair and redeems the code for its credential
  (`10-auth.md` § Surface linking) — the same nonce the QR carries, typed
  because a browser has nothing to scan with.
- The credential token (a JWT starting with `eyJ…`) from `patch auth bootstrap`,
  which is the very first sign-in of an account that has no linked surface yet.

Each value is validated for shape before anything is stored: a JWT must be
3-part and carry a `surface_id` claim (signature is the server's job), and a
pairing code must be the short-code shape. The copy names both routes, and says
that the daemon-registration code from Add host authorises a machine rather than
a sign-in, so a value pasted from the wrong screen is rejected up front with an
inline error. A malformed value in storage is self-healed: it's dropped and the
pairing screen returns.

## Offline / error states

- Top bar turns amber with "Reconnecting…" when the server WS drops. Composer disabled; inbound queue persists in memory until reconnect.
- Per-chat banner when the chat's host is offline, naming it: "<host> offline — messages queued."
- Both banners carry a Diagnose action opening the connection diagnostics screen, and that screen takes over the window when the surface has yet to connect and two attempts have failed (`12-error-and-offline.md` § Connection diagnostics screen). It lists credential / server / agent-link / WebSocket checks with their real detail text, a Retry now button that dials immediately, and Copy report.
- Per `12-error-and-offline.md`: on reconnect, `replay` is sent for the chats whose transcripts this surface already holds (the open chat and any with a rendered timeline) — not for the whole roster — and missed events stream in. On a cold start no transcript is requested at all: the sidebar comes from the single `GET /api/chats` metadata call and each transcript loads on open.

## Theming

The app ships light and dark palettes and follows the OS by default.

- Palette source of truth. The whole visual system is CSS custom properties
  (`--bg-app`, `--bg-panel`, `--bg-elevated`, `--bg-soft`, `--ink`/`--ink-2`/`--ink-3`/`--ink-faint`,
  `--line`/`--line-soft`, `--accent`/`--accent-soft`/`--accent-strong`/`--accent-tint`,
  the state colours `--running`/`--waiting`/`--voice`/`--read` + their tints, `--diff-add`/`--diff-del`,
  the table tokens `--table-border`/`--table-head`/`--table-stripe`, the shadows, and semantic tokens `--on-accent`, `--danger`, `--leaf`, `--voice-tint`,
  `--text-muted`, `--bg-code-on-accent`, `--diff-line-mod*`, `--git-pending`). The `:root` set is the light palette; no component hardcodes a
  colour — every surface, text, border, accent, diff, toast, chat bubble, composer, sidebar,
  folder popup, terminal and empty-chat graphic reads a token, so switching palettes is a single attribute
  flip. (The voice bar is a deliberately dark strip in both palettes — the voice-NOTE
  overlay is not a capsule at all, just a tokened transcript line, `07-voice-app.md` § Voice-input modes;
  the image lightbox + modal backdrops are translucent-black overlays in both modes; the QR canvas
  stays white so it scans.)
- Dark palette. Warm dark paper — not pure black. Surfaces invert their elevation so the
  main content panel (`--bg-elevated`) is the lightest surface (as it is white in light mode) and
  the app background is the deepest (~`#17140f`); ink is a warm off-white. The accent and state
  hues are muted against that ground rather than brightened onto it: the same leaf green
  (`#77a966`, strong `#95c186`), amber, indigo and terracotta as light, held at roughly two-thirds
  of the light palette's chroma. `--accent` is a solid fill on buttons, badges and bubbles, so a
  saturated green there reads as a neon slab against near-black; the muted value reads as colour
  that was chosen. Every accent and state hue still clears AA (4.5:1) on all four dark surfaces —
  the headroom comes out of saturation, not contrast. `--on-accent` is the text/icon colour on any
  accent/state fill — white in light, a dark warm ink in dark so button labels always clear AA.
  The state hues stay mutually distinguishable at badge size, which is the size that decides how
  far the chroma can come down.
- Tables. A markdown table in the transcript is legible in both palettes: its grid lines clear 3:1 against the surface behind the table and against the row fills they run between, the header row has a fill of its own that stands clear of the surface and the body rows, every other body row is striped, and cell text clears AAA (7:1) on every fill it sits on.
- Terminal palette. The terminal (§ Terminal) carries its own `--term-*` set — surface, ink, dim
  ink, rule, restart-button fill, stderr red and caret green — because it is a recessed surface in
  both modes rather than an ordinary panel: warm paper set below the white panel in light, the
  deepest surface of all in dark. Ink, stderr and caret each clear AA against that surface in both
  palettes. Dark-mode stderr goes further and clears AAA (7:1): it carries body-text volumes rather
  than single error lines (§ Terminal), and a saturated red at 12px on the deepest dark surface
  halates badly long before it fails a contrast check. It is a lifted, muted salmon for that
  reason — still unmistakably the warm stream against the neutral off-white of `--term-ink`.
- Editor palette. Monaco (§ Editor — two surfaces) is the one surface that cannot read a CSS
  variable: its theme API takes fixed colours. So a single editor theme is derived from the same
  tokens the rest of the app uses — `--bg-elevated` for the editor surface, `--ink`/`--ink-3`/
  `--ink-faint` for text, line numbers and indent guides, `--line` for widget borders and rules —
  and it is defined before the first editor mounts, so there is no light-theme flash. Every Monaco
  surface (a file tab's plain editor, its diff toggle, a permission-request diff) uses it; none falls
  back to a built-in VS Code theme. Diff washes are `--accent` (added) and `--danger` (removed) laid
  over the editor surface at low alpha rather than the flat `--diff-add`/`--diff-del` fills, so the
  same pair works in both palettes: each wash clears the surface it sits on, and green-vs-red hue
  separation — not lightness — is what distinguishes added from removed. When the OS preference
  flips, the theme is re-derived from the freshly-cascaded tokens and re-applied to the already
  mounted editors: they repaint in place, without remounting or losing scroll/selection.
- Always follows the OS. There is no in-app theme control and no override. The dark palette is in
  a `@media (prefers-color-scheme: dark)` block, so the OS preference paints correctly on first
  load before any JS runs — no flash, no bootstrap. Light is `:root`; dark is the media block. We
  deliberately do not offer a System/Light/Dark picker: the OS is the single source of truth, so
  there is no `localStorage` theme key, no `data-theme` attribute, and no Settings → Appearance
  section.
- Minimal chrome. Legibility over flair — you'll read long streams.

## Manager incoming-call UX

Desktop equivalent of Android `ConnectionService`. When the server triggers a Manager call (per `07-voice-app.md` § Agent-initiated voice):

- App window raises to foreground if backgrounded or minimised.
- Audible chime (one short tone).
- Banner overlay over the chat panel: red header strip "MANAGER IS CALLING", a green-ringed avatar with the chat name, and two big buttons: Dismiss | Accept.
- Accept → opens Manager voice session full-screen takeover (see `07-voice-app.md` § Voice-input modes).
- Dismiss → events fall through to the in-app inbox.

Desktop OS does not auto-pause media — Spotify, podcasts, browser tabs keep playing while voice plays. User has to manage their own audio. Worth a one-time tooltip on first-call: "playing other audio? it won't auto-pause."

## Menu bar surface (macOS, equivalents on Linux/Windows)

Patch ships a small system-tray / menu-bar item for always-on access without opening the full app. Reference mock: `design/web-hi-fi-menubar.html`.

Two interactions:

### Click — dropdown panel

A 360px-wide popover anchored to the menu-bar icon. Top to bottom:

1. Manager — first row, semibold, with two icon buttons on the right: a phone icon (open a voice call to Manager) and a mic icon (tap-and-hold to send a voice note to Manager).
2. Chats — the same chat list shape as the sidebar, just compact. Each row carries the standard status badge, name, folder + one-line preview, relative time, and a hover-revealed mic button. Five most-recent chats by default; clicking a row launches the full app focused on that chat.
3. Manager input — single text input at the bottom, placeholder `Manager…`, with a send arrow. `⏎` fires the typed text as a user turn into Manager.

The dropdown is glanceable: just the three elements above, with no connection-state header, section labels, or hints.

### Global hotkey — voice ingress without opening the dropdown

User-configurable global chord (default proposal: `⌃ Space`). Two gestures:

- Press-and-hold → opens the voice-note overlay (see `07-voice-app.md` § Overlay surfaces) targeting Manager. Release sends.
- Tap → opens the same overlay in toggle mode (Superwhisper-style). Tap again or `⏎` sends; `esc` cancels.

The overlay is the same one used for any chat's tap-and-hold mic; the targeted chat is Manager when triggered from the menu bar, the row's chat when triggered from a sidebar mic-btn.

The menu-bar surface writes text into the host from two places: the Manager input and the voice-note overlay's transcript. Reading transcripts and navigating chats happens in the full app.

## Meeting mode

A chat can listen to a meeting. A **Meeting** button sits beside Call in the composer; pressing it again ends the meeting. The meeting lives in the chat: Tom can ask questions or tell it to do things, and the chat's model sees the meeting as context (the panel plus any transcript it has not yet been given, as a system-reminder on his next turn). The raw transcript is never posted as chat messages.

- **Capture.** Microphone ("You") on every surface; on the desktop app also system audio ("Them"), tapped by the shell's native helper (`patch-audio`, a Core Audio tap that streams 16 kHz PCM; no screen is shared, so macOS shows no picker and no screen-sharing indicator, and the one-time permission is System Audio Recording). Audio is cut into ~15 s 16 kHz mono WAV clips by sample count, silent clips are dropped, and each goes up as `meeting.audio`. Capture is acquired before the host is told to start: a denied mic starts nothing and says so. System audio unavailable on desktop fails the start loudly.
- **Start and end prompts (desktop).** The shell notices a call the way Granola does: a known calling app (Zoom, Teams, FaceTime, Slack, Discord, or a browser) opening the microphone raises a _Meeting started_ toast; clicking it starts a meeting in the open chat. When every calling app has let go of the mic for 10 s while Patch is capturing, a _Meeting ended_ toast offers to end it. Patch's own mic use never counts, no toast appears for a meeting Patch is already capturing, and detection that cannot run says so rather than going quiet.
- **Host.** Transcribes with the host's LOCAL Whisper only (never a paid STT backend). About every 30 s, one cheap model pass folds the new transcript into Now / Discussed / Actions. The timer lives on the host, so a hidden window does not stop it. A failed transcription or analysis is shown on the panel (`meeting.state.error`), never swallowed. After a host restart a live meeting reloads as paused.
- **Panel (right, ~34%).** Live timer pill with Pause/Resume and End; **Now** (headline, up to 3 bullets, who is speaking); **Discussed** (topics newest first, timestamp, key points, _Decided_ badge); **Transcript** collapsed, with search. After End the pill reads _Ended · N min_ and **Summary** replaces Now. If the host says live but this device is not capturing (page reload), the panel says so and offers **Listen here**.
- **Actions** stack above the composer as cards (**Do it** / **Dismiss**), newest first, persisting until dealt with. _Do it_ sends the action to the chat as a normal turn, so the chat's own tools and permissions apply; the card collapses to a tick with the time. Dismissed cards disappear.
- **Narrow screens** stack the panel under the chat; the Now / Actions / Chat tabs layout is not built yet.

## Cross-refs

- Presence + QR linking: `05-surfaces.md`
- Voice behaviour: `07-voice-app.md`
- Disconnect/replay semantics: `12-error-and-offline.md`
- Job shape: `08-triggers-and-jobs.md`

Job bar. A chat a job created (`jobId` set — `08-triggers-and-jobs.md` § Action) carries a bar directly under the chat header reading "Run by a job" with an Open job link to `/jobs/:id`. A chat no job created has no bar.
