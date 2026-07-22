# ProxyHub design fidelity ledger

## Accepted concept

- Concept image: `proxyhub-dashboard-concept.png`
- Implementation capture: `proxyhub-dashboard-implementation.png`
- Image generation tool: built-in OpenAI ImageGen
- Final concept prompt: "Create a polished 1440×1000 desktop SaaS dashboard concept for ProxyHub, an open-source VPS proxy infrastructure manager. Use a compact pale-blue left sidebar, cool-white workspace, navy typography, electric-blue primary actions, Manrope/DM Sans-style type, six health metrics, a traffic chart, security score ring, server table, and recent activity. Keep it airy, operational, trustworthy, and implementation-ready; avoid gradients, glassmorphism, oversized text, and decorative hero art."

The generated bitmap is a design reference only. The product UI is implemented with React, CSS, Lucide icons, and Recharts, so no runtime image-generation dependency or baked-in text is present.

## Fidelity checks

1. **Structure:** 244 px desktop sidebar, compact top bar, metric strip, two-column analytics row, and server/activity row match the accepted concept hierarchy.
2. **Palette:** cool white, pale blue, navy, electric blue, and semantic green/amber/red values were carried into the design tokens, including dark-mode counterparts.
3. **Typography and density:** display numerals/headings use Manrope and interface copy uses DM Sans, with compact controls and restrained card padding.
4. **Icon language:** Lucide outline icons use consistent weight and sizing; the ProxyHub mark is code-native rather than a raster logo.
5. **Copy:** navigation and primary actions preserve the approved labels. Dynamic server, traffic, security, and activity values intentionally come from the API instead of the concept's illustrative data.
6. **Interaction:** the implemented surface adds functional node creation, QR sharing, pool membership, session security, notifications, command palette, theme switch, and responsive mobile navigation without changing the dashboard's visual hierarchy.

## QA notes

- Recharts animation was disabled so rendered output and visual regression captures are deterministic.
- Browser QA covered authentication, node creation/share, pool assignment, dashboard data, console errors, and a 390×844 responsive DOM boundary check with no horizontal overflow.
- The in-app browser's explicit large-viewport screenshot backend clipped 1440/1536 px captures despite correct DOM viewport dimensions. The committed implementation capture therefore uses the stable native 1280×720 capture; large-viewport fidelity was checked through computed DOM bounds.
- Intentional visible data deviations: the implementation capture shows real local QA records and a computed 100 security score, while the concept uses illustrative server records and an 86 score.
