Refer to this file when writing new spec files or amending existing ones.

# Principles

The spec is the source of truth and always overrides anything that has been
implemented. It should be concise and easy to follow.

Simpler is better. Concise and clear descriptions are better than long, wordy
and difficult to absorb descriptions. The spec should provide just enough to
make it clear what should be built so it constrains the features themselves
without enforcing the detail of how something is done beyond the tech stack
itself.

Don't repeat things. One single clear description is far better than multiple
iterations that each capture part of the design, even if it's in the same
document. No intros or summaries. This makes it harder to update and keep
consistent.

The spec shouldn't make any reference to anything external to it unless it is
relevant documentation. It shouldn't make any reference to JIRA tickets or to
code because it is a hermetic document that only makes references to itself.

The spec shouldn't make reference to past or future versions of the app or the
code. It shouldn't reference why certain things are removed. It's intended to be
the canonical document that an application could be built from with no other
knowledge. It doesn't describe what might be done in the future or what's out of
scope. It simply describes the application as it should be right now. There is
no need to exclude anything from the spec on the grounds that it's difficult to
build or implement, or that it will come later. We build exactly what we need
right now rather than planning for the future. There's no need to mention what's
out of scope.

It should be internally consistent and when making changes ensure that by
changing one area something else isn't invalidated. A way of ensuring that this
is adhered to is not to duplicate anything. One file should be responsible for
one specific feature with minimal description elsewhere, prefer references over
duplication.

The document doesn't explain why things are done certain ways unless it's genuinely helpful to a future reader. Many things are obvious patterns and don't need explanation. Think about code comments. Code comments are only relevant
when something is unusual and couldn't be inferred from the description itself. Or when someone would pick an inferior alternative because they haven't realised the downsides. In those cases explanations are useful to prevent flipping back to poor design choices.

The spec doesn't describe granular detail about code writing or modules, it
describes behaviours and outcomes. It does encode the general shape and
principles and the way things fit together, but respecting the fact that a
developer knows how to do basic stuff. The spec is the outcome of a group of
developers sitting around in a room together chatting through an idea. They come
out with an agreement on the architecture. They don't need to say on line 37 put
a try catch.

Assumptions in the spec should be verified. Don't describe options, the spec is
the stage when all research on external dependencies and tradeoffs should be
locked down.

Not every change will require a spec update. Some bugs may be down to poor definition, but some bugs may simply be bad implementation where the spec is already accurate and comprehensive enough.

Don't add formatting to the spec like bold and italics. These aren't useful to the reader
