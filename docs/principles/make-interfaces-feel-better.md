# Details that make interfaces feel better

Use the target project's existing styling system, tokens, components, and
accessibility requirements. Do not introduce a styling or animation dependency
just to apply a polish preference. Values in these references are examples, not
universal acceptance criteria.

## Choose a topic

- [Typography](make-interfaces-feel-better/typography.md): wrapping and stable numbers.
- [Surfaces](make-interfaces-feel-better/surfaces.md): radii, alignment, elevation, and hit areas.
- [Animations](make-interfaces-feel-better/animations.md): state transitions and interruption.
- [Icons](make-interfaces-feel-better/icons.md): optical weight, consistent sets, and states.
- [Performance](make-interfaces-feel-better/performance.md): transition properties and profiling.

Read only topics relevant to the requested interface or changed behavior.
Detailed examples remain subordinate to this scope and the product's design
system; verify library-specific APIs before copying them.

## Apply with judgment

Start with readability, keyboard and touch access, focus, state feedback, and
reduced-motion behavior. Fix concrete user problems before aesthetic preferences.
Retain structural and focus borders; elevation effects are not a substitute for
visible state. Match existing icon and surface tokens before tuning one component.

Use motion only when it communicates state, continuity, or useful feedback.
Frequent interactions may need instant feedback. A press scale such as 0.96 is
an example, not a required value or an excuse to change an established token.
Respect reduced-motion preferences and keep a non-motion feedback channel.

Prefer transitions that can be interrupted for reversible state changes. Match
installed animation-library conventions instead of importing another package.
Measure expensive effects on representative browsers and devices rather than
assuming an API or property is always hardware-accelerated. Use targeted
transition properties and reserve `will-change` for demonstrated need.

## Review

Stay within requested authority. Use the caller's report format and verdict
contract. Optional polish is advisory; do not require changes merely because a
numeric example, easing preference, or screenshot differs.

Cite inspected files/components and explain the user impact of each material
finding. Check relevant focus, active, loading, empty, and error states. Inspect
motion at reduced speed when useful; do not claim browser or device checks that
were not performed. Report unverified surfaces and real limits without inventing
findings, rejected candidates, or mandatory empty tables.
