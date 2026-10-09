// The New chat tab's route file. It is deliberately NOT the thing you see when
// you tap the tab: `_layout.tsx` intercepts that press and pushes the real
// `/new-chat` screen, so this route is normally never focused or even mounted.
//
// It re-exports the flow rather than redirecting to it. A `<Redirect>` here is
// what broke the tab: `Redirect` fires from `useFocusEffect`, so a tab that
// stays focused after the redirect fires it again — mount → replace → mount,
// until React gives up with "Maximum update depth exceeded" and renders
// nothing. That is the blank screen; the loop also wedged the whole UI, so no
// other tab responded either. Re-exporting cannot loop: if this route ever is
// focused it simply draws the flow.
//
// The FILE NAME matters too. A `(group)` segment is transparent in the URL, so
// the old `app/(tabs)/new-chat.tsx` and `app/new-chat.tsx` both claimed the
// path `/new-chat` — which is how a redirect to `/new-chat` could resolve back
// to the redirect itself. `__tests__/tabs-newchat.test.tsx` guards both halves.

export { default } from '../new-chat';
