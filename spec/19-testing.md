# Testing

Every test belongs to exactly one of five layers. A layer is defined by what is real in it and what is substituted. Choosing a layer is not a matter of taste: the layer follows from what the change is, and for a bug fix it follows from where the bug was observable.

## The layers

| Layer       | Real                                                     | Substituted                     | Owns                                                                                                         |
| ----------- | -------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unit        | One module                                               | Everything it talks to          | Logic, branches, error paths, edge values                                                                    |
| Contract    | The wire protocol encoder and decoder                    | Both peers                      | That server, host and surfaces at different versions still understand each other                             |
| Integration | Two or more real components across their real seam       | Only the external agent backend | That a feature actually happens end to end                                                                   |
| Browser     | A real browser engine, real CSS, the real component tree | The server                      | What a simulated DOM cannot compute: layout, computed style, element size, overflow, scroll, focus, pointers |
| Surface     | The built artefact on its real platform                  | Nothing                         | Native behaviour: permissions, notifications, background and foreground, tray, hotkey, install, update       |

## Unit

Coverage is enforced at 100% so that it fails rather than warns. Exclusions are permitted only for files with no runtime logic, and each exclusion carries its reason.

Coverage is a floor, not evidence. A package at 100% with every seam substituted has shown that its branches execute, not that its feature works.

Test discovery is by pattern, never by a hand-maintained list of files. A list silently drops any test file nobody remembered to add, which makes the suite quietly smaller than it looks.

## Contract

Server, host and surfaces deploy independently, so different versions of them run at the same time. The wire protocol is the only thing holding them together, and it is tested on its own.

For every wire event, in both directions: it encodes, it decodes, an unrecognised field is preserved rather than rejected, and an unrecognised enum value is surfaced rather than discarded.

A decoder that rejects an unrecognised field turns every additive protocol change into an outage for every peer that has not updated yet. A decoder that discards an unrecognised enum value produces a lost message with no error anywhere, which is worse, because nothing reports it.

## Integration

Back end: a real server and a real host, communicating over a real socket, with the host authenticating exactly as it does in production. Only the agent backend is substituted. Every wait is bounded by a timeout, and a turn that produces neither a reply nor an error fails the suite. This is the only layer where a chat that hangs with no response and no error is visible at all.

Front end: the real client render tree, the real stores, the real event dispatch and the real controllers, driven against a scripted server boundary. Assertions are made on rendered output. Asserting on events instead permits a turn that is accepted on the wire and never appears on screen.

Anything about routing between hosts is tested with two hosts attached to one server. One host cannot show a turn delivered to the wrong host.

## Browser

A real browser drives the component dev harness with the real stylesheets loaded and no backend behind it.

A test that could pass with a simulated DOM belongs at the unit layer, where it runs in a fraction of the time.

## Surface

The built artefact on its platform: the app on an Android emulator, the packaged desktop shell, the built CLI binary, the voice device firmware, the deployed stack.

This layer is run explicitly and is not part of the verification gate, because it needs an emulator, a device or a display.

Anything that needs a human present to observe it is recorded as untested. It is never reported as passing on the grounds that it probably works.

A surface test ASSERTS INVARIANTS AND DISCOVERS ITS JOURNEY. It does not hold a table of taps and expected strings. Two reasons, both of which cost a day on 11 September 2026. Every product string in such a table is a UI decision someone is entitled to change, so a correct build fails on a rename — and a smoke that cries wolf is read as crying wolf on the day it is right. And a string check cannot express the failures that actually happen: asked "is `Chats` on screen" while the app was restarting under it (an OTA applying on the next launch, exactly as designed), it answered no, three times, about a build that was fine.

So a surface test reads the navigation the app paints, opens whatever it finds, and asserts what must hold of any version of the app: the app is still in the foreground, its process did not restart under the step, the screen is not blank and not a generic error screen, the destinations are not all the same dead screen, at least one carries real content, the running bundle is the build under test, and the log carries no crash, render loop, unhandled error or ANR. A renamed tab, a reworded empty state or a new destination needs no change to the harness. Where a genuine restart does occur it is named as one and retried from a settled app, because "the app went away" and "the screen is wrong" want opposite fixes.

## Isolation

A test never reads or writes the machine's own Patch state. Every test that boots a host supplies its own state directory and its own control socket, and a test whose state resolves inside the machine's own directory fails naming that path rather than running.

A test removes what it creates when it finishes, including after a failing assertion, and creates nothing at all on a machine where it does not run. A test that drives a real agent is held to this too: the chats that agent creates are the test's to remove. Anything that reaches the machine's own store is reported and left in place, because it belongs to the user and deleting it is not the suite's call.

A test that drives a real agent gives that agent no route off its own host. The tools it is told to use are present before the run starts, and a missing one fails the run rather than degrading it, because an agent that cannot find the tool it was told to call reaches for whatever else looks equivalent — and the command line tool on the machine's path acts on the machine's host. The shell is withheld from such a session, since instructions in a prompt constrain what an agent intends, not what it can do.

## Which layers a change requires

| Change                                             | Layers                                             |
| -------------------------------------------------- | -------------------------------------------------- |
| Any change at all                                  | Unit                                               |
| A new or altered wire event or field               | Contract                                           |
| Behaviour that crosses a process or component seam | Integration                                        |
| Behaviour a user sees rendered                     | Browser, when it depends on layout or real styling |
| Behaviour that depends on the platform             | Surface                                            |
| A bug fix                                          | A test at the layer where the bug was observable   |

## Regression tests

Every bug fixed gets a test. It goes at the layer where the bug was observable, which is frequently not the layer where the code changed. A rendering bug caused by a controller is a rendering bug: a unit test on the controller passes in ignorance of it, because the thing that was broken was the rendered result.

The test must fail before the fix and pass after it, and that failure must be demonstrated by running it against the unfixed code rather than assumed. A regression test that never actually failed is a test of the fix's presence, not of the bug's absence.

## Verification

One command runs every layer that runs unattended: lint, types, unit with coverage, contract, integration, browser, and the check for mocks leaking into shipped code.

It is the whole gate; there is no separate pipeline to satisfy. Deploying runs it first and refuses to deploy if it fails.
