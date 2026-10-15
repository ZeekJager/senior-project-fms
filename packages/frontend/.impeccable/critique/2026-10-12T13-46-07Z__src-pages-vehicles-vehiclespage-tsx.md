---
target: Vehicles screen and shell
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Users\\yonas\\OneDrive\\Documents\\GitHub\\senior-project-fms\\packages\\frontend\\src\\pages\\Vehicles\\VehiclesPage.tsx"
target_fingerprint: "sha256:986ee8d89b6ee119502f0619f9879f2e3e3485a68edd8d8b2e2b30386819e8bc"
target_path: "C:\\Users\\yonas\\OneDrive\\Documents\\GitHub\\senior-project-fms\\packages\\frontend\\src\\pages\\Vehicles\\VehiclesPage.tsx"
timestamp: 2026-10-12T13-46-07Z
slug: src-pages-vehicles-vehiclespage-tsx
closed: true
---
Method: dual-agent (A: design review, B: detector and browser evidence)

# Critique: Vehicles screen and shell. 28/40 (Good)

Scores: 1 Status 3, 2 Real world 3, 3 Control 3, 4 Consistency 3, 5 Prevention 3, 6 Recognition 3, 7 Efficiency 2, 8 Minimalism 3, 9 Recovery 3, 10 Help 2.

Design specificity: competent but generic; swap "Vehicles" for "Invoices" and the shell ships unchanged. The plate, the product's identity, is ordinary 14px text. The page answers "24 active, 100% available" instead of "what can I dispatch now".

Detector: static scan of src is clean; runtime overlay found pulsing-dot on /vehicles, 25 low-contrast (Present button 3.8:1) and 30 top-stripe accent cards on /attendance, 2 minor on /dashboard placeholder.

Priority issues
- [P1] Page does not answer the dispatcher's question; the status filter is repeated three times (stat card, dropdown, switch). Fix: decision-oriented strip (Ready to dispatch, Flagged, In workshop, Documents expiring), one control per question. Commands: distill, layout.
- [P1] Row actions 32x32px, hover-faded, Edit and Decommission 8px apart; Documents pill under 24px. Fix: row opens detail panel, Decommission into a menu, 44px targets on coarse pointers. Commands: adapt, harden.
- [P2] No product identity, flat type hierarchy (plate not an anchor; top bar repeats the logo). Commands: typeset, shape.
- [P2] Contrast and focus: dark sidebar group labels 4.14:1, Present button 3.8:1, dark focus ring 2.90:1. Command: audit.
- [P3] Efficiency and copy: 12 sidebar tab stops, no "/" shortcut, "1 items", ambiguous date format, "across your depots" with one depot. Commands: clarify, polish.

Personas: Alex (no shortcuts, bulk actions, saved views), Sam (weak dark focus ring, near-floor subtle text), Casey (first vehicle ~590px down, tiny close actions, drivers see a fleet table), depot technician on a tablet (rail icons unlabeled on touch, 36px controls, no start-repair).

Minor: 12px most common size; confirm blank-before-skeleton on throttled API; en-route pulse reduced-motion; accent-card top stripes; collapse button far from the task.

Questions: what is the page for if dispatchers never open it; what is distinctly a depot or Ethiopian; why is one filter offered three times.
