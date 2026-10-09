# Day in the Life

The product test. If patch can serve this day end-to-end, the spec is right. If it can't, we have gaps.

This is not exhaustive coverage of features — it's the path through them that proves the system holds together.

## 1. Morning — silent check-in

Wake up, open phone. Overnight, two patch jobs ran:

- 02:00 — Home Assistant update. Cron-trigger job spawned a fresh chat in `~/jobs/ha-update`. The chat used the agent's `Bash` tool to SSH into the HA box, ran `ha core update` and reboot, sanity-checked the dashboard came back up. It would have called `patch_notify(channel: 'push', priority: 'urgent')` if anything failed. It didn't, so I see nothing. The chat sits in the sidebar as an artifact — if I want to know what happened I open it; otherwise it's just there.
- 08:00 — news briefing. Spawned a chat that read overnight feeds and produced a summary. The chat sits in the sidebar; I open it when I want to read it.

Phone was silent overnight because the OS was in Do Not Disturb. Patch does not implement its own quiet hours — the OS already does that. The HA-update job's `urgent` priority would have broken through DND on failure, which is the point of urgent.

## 2. Reporting agent in Teams

A reporting agent lives in Microsoft Teams as if it were an employee. It heartbeats every 30 minutes, summarises what's happening, and responds when messaged. Teams is not a new special thread or ingress channel — HA is an intentional exception, not a template. Teams is a normal chat that:

- Inbound: Teams events POST to a generic webhook (spec 08), JSONata-filtered, action sends as user input to the chat (or spawns a fresh one).
- Outbound: the agent posts to Teams via an MCP, or by shelling out to a Teams CLI installed on the host. The CLI is not part of patch — it's whatever third-party tool exists.

Same pattern works for Slack, Discord, Linear, GitHub, anything. No new ingress channel in patch core; just webhook + chat + tool.

## 3. Home Assistant fix via Todoist

Downstairs, something's wrong with the home automation. I add a task in Todoist. Patch's Todoist trigger picks it up, spawns a chat in the HA project folder, fixes it, and notifies me when done. The notification lands in the patch app (push if backgrounded, in-app banner if foregrounded).

## 4. Three jobs from the bathroom

Brushing teeth, I open patch on my phone and kick off three new chats in three different project folders. They start working independently.

## 5. Switching to the desktop

Sit at my laptop, open the desktop app. The three chats are listed live in the sidebar. I flick between them, answer questions in each, the others keep running while I'm focused on one.

## 6. Walk with headphones — Manager rings me

Stick on headphones, phone in pocket, screen off. The Manager agent calls me. Not me tapping a mic — Manager calls `patch_call({ reason: 'agent one finished step X, decision needed' })`. Phone and (idle) desktop ring concurrently; phone accepts first, desktop stops ringing. The call drops into the voice-call overlay against Manager. "Agent one has finished step X, what do you think?" I answer verbally. Then "Agent two is asking which option, A or B?" I say "tell agent two to go with B." Manager dispatches that to agent two via `patch_send_to`. I end the call.

The phone treats this as a real call via Android's `ConnectionService`. Headphones are the audio path. The patch app is the call host.

## 6b. Mid-afternoon — kitchen speaker

Walk into the kitchen, fridge open. Say "kitchen, lights to thirty." The voice device picks it up, audio streams to the host, Whisper transcribes, the turn lands in the Speakers thread tagged `[voice • kitchen]`. The agent calls Home Assistant's REST API as a tool and replies; reply auto-routes back to the kitchen device as TTS — "done, kitchen at thirty." No notification fires, the thread accumulates the exchange. Later from the desk I scroll the Speakers entry in the Channels section to confirm what got changed; the composer is disabled because Speakers is voice-only ingress.

For the same kind of control from the desk I have a separate pinned HA chat at the top of the sidebar. I tap-and-hold the chat row in the sidebar (no opening), say "porch lights off," release; the message goes straight in as a user turn, the agent fires the REST call, the reply slides into the chat I left unopened. Same agent, same tools — different ingress point.

## 7. Back to the laptop — quick edit

Agent one has edited some files. I open the in-app editor, tweak a few lines, save — the agent is still working and that makes no difference; the save goes through. This is a "fix a typo" editor, not an IDE.

## 8. Design work — voice with one agent directly

I want to do design work. Click into the relevant chat, tap mic, talk to that agent directly — not Manager. Voice routes there via focus-follow. I iterate on the design verbally with that one agent. End the call when done.

---

## What this exercises

- Durable cron jobs that spawn fresh chats: silent on success (the chat is the artifact), `patch_notify` only fires on failure.
- A long-form output job (news briefing) producing a chat the user opens at leisure.
- A third-party integration (Teams) implemented purely via webhook + MCP — no new ingress channel in patch core.
- External-event trigger (Todoist) → auto-spawn → in-app notify on completion.
- Multi-chat parallelism initiated from mobile.
- Mobile-to-desktop continuity over the live event stream.
- Agent-initiated voice — the agent rings the user, not the reverse.
- Voice cross-chat dispatch (Manager voice routing replies to agent two).
- Speakers thread + auto-route reply back to source device (`deviceId: kitchen`).
- Pinned HA chat as the desk-side smart-home surface — distinct from Speakers.
- Sidebar tap-and-hold mic shortcut on a chat row — speak without opening the chat.
- In-app editor saving while the chat's agent is still mid-turn.
- Focus-follow voice with a non-Manager chat.

## What this deliberately does not exercise

- Authentication / device linking (assumed already done).
- Job CRUD UI (assumed already created).
- Failure cases (those live in `12-error-and-offline.md`).
- The first run / onboarding (assumed past).
