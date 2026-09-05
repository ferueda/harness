# Design engineering principles

A maintained reference inspired by [Emil Kowalski's work](https://animations.dev/),
not an upstream specification. Apply it only to relevant interface decisions.
The target product's design system and accessibility requirements take precedence.

## Purpose before motion

Ask what an animation communicates and how often users will encounter it. Remove
unhelpful delay from frequent actions; do not categorically remove useful feedback
solely because the interaction uses a keyboard. Spatial continuity, meaningful
state feedback, and a clear transition can justify motion; decoration alone may not.

## Fit the component

Use existing motion and press-feedback tokens. Duration, easing, scale, and
bounce are contextual choices, not universal constants. Anchored popovers should
reflect their trigger relationship; centered dialogs have a different spatial
model. Do not turn an isolated stylistic alternative into a review blocker.

For reversible interactions, choose transitions or springs that behave well when
interrupted. Avoid abrupt restarts and distracting overshoot. Keep temporary
loading and status changes legible rather than using animation as their only cue.

## Keep interaction reliable

Design drag interruption, pointer capture, cancellation, and resource cleanup
alongside the visual effect. Check focus management and keyboard access. A copied
or clipped visual layer must not create duplicate accessible controls. Destructive
interactions need real task authority and accessible confirmation behavior; a
visual hold effect is not an authorization mechanism.

Respect reduced-motion preferences. Preserve useful static feedback and remove
non-essential movement. Test relevant touch and pointer states without assuming
hover behavior applies to every device.

## Verify rather than generalize

Profile motion on representative browsers and devices. Do not claim that every
CSS animation, clipping effect, or library shorthand runs off the main thread.
Prefer low-cost properties when they satisfy the design, but measure actual
rendering rather than treating a property whitelist as proof.

Inspect transitions at normal and reduced speed when available. State which
interactions and devices were actually checked; source inspection alone cannot
prove perceptual quality. In a review, follow the caller's scope, result format,
and blocker criteria. Concrete accessibility or behavior defects differ from
optional visual polish.
