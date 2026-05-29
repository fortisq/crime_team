// Curated preset prompts for the crime-team orchestrator.
// Edit this file to add your own — refresh the window (Ctrl+R) to pick up changes
// in dev mode, or rebuild for a release build.

export const PRESETS = [
  {
    group: "Combos (recommended)",
    items: [
      {
        label: "Universal Findings (best default)",
        prompt:
`Do a read-only Findings pass on this system. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Judge it from two angles:
1. Will this hurt player experience?
2. Will this slow development later?

Report only the highest-value findings. Ignore minor style issues unless they create real risk.`,
      },
      {
        label: "Systems + Player Experience",
        prompt:
`Audit this system for both code risk and player experience. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Prioritize issues that could create player confusion, exploits, hidden bugs, or future dev slowdown.`,
      },
      {
        label: "UI + Onboarding",
        prompt:
`Review this UI/system for onboarding and usability. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Focus on confusion, missing guidance, poor feedback, and things a new player would not intuitively understand.`,
      },
      {
        label: "Scaling + Maintainability",
        prompt:
`Audit this for long-term scaling during development. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Highlight anything that will become messy, repetitive, fragile, or expensive as content grows.`,
      },
      {
        label: "Exploit + Balance",
        prompt:
`Do a Findings pass for exploit risk and balance instability. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Focus on loopholes, dominant strategies, economy abuse, reward inflation, and progression-breaking interactions.`,
      },
      {
        label: "Universal Findings — sharp version",
        prompt:
`Do a read-only review only. No code changes, no rewrites, no patches. I only want a concise Findings report with:
1. What's working well
2. Risks / weak spots
3. Player experience impact
4. Dev-time impact
5. Top 5 highest-value improvements to consider later

Prefer practical findings over style nitpicks. Focus on issues that matter during active game development.`,
      },
    ],
  },
  {
    group: "Player-facing audits",
    items: [
      {
        label: "Player onboarding",
        prompt: `Audit this system for first-time player onboarding. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Identify confusion points, missing feedback, friction, and places where new players may quit or get lost.`,
      },
      {
        label: "Moment-to-moment UX",
        prompt: `Review this for moment-to-moment player experience. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Look for friction, unclear interactions, clunky flow, redundant clicks, poor feedback, and anything that makes the game feel harder to use than it should.`,
      },
      {
        label: "Fun killers",
        prompt: `Do a Findings pass for anything here that could quietly reduce fun over time. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Focus on annoyance loops, pacing drag, repetition, friction, waiting, and player fatigue.`,
      },
      {
        label: "Feedback and clarity",
        prompt: `Review this for player feedback quality. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Look for places where the player may not understand what happened, why it happened, whether an action succeeded, or what to do next.`,
      },
      {
        label: "UI responsiveness and feel",
        prompt: `Audit this for UI responsiveness and feel. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Flag delays, overcomplicated flows, missing confirmations, poor defaults, and anything that makes menus or interactions feel sluggish or awkward.`,
      },
      {
        label: "Progression feel",
        prompt: `Audit this for progression feel. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Identify grind walls, pacing dips, weak rewards, confusing advancement, and places where players may stop feeling momentum.`,
      },
    ],
  },
  {
    group: "Code / risk audits",
    items: [
      {
        label: "Bug-prone design",
        prompt: `Read this as a bug-risk audit. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Flag brittle logic, edge cases, state desync risks, unclear ownership, hidden dependencies, and places likely to produce hard-to-repro player bugs.`,
      },
      {
        label: "Performance hotspots",
        prompt: `Do a Findings-only performance audit. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Focus on likely hotspots, repeated work, unnecessary refreshes, heavy loops, memory churn, and systems that may scale badly with more content or more players.`,
      },
      {
        label: "Maintainability",
        prompt: `Review this for maintainability during active development. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Highlight complexity, duplication, unclear responsibilities, naming confusion, and areas that will slow future feature work.`,
      },
      {
        label: "Content scaling",
        prompt: `Audit this for content scalability. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Identify anything that becomes painful as the game grows: adding items, maps, quests, enemies, skills, dialogue, or UI content.`,
      },
      {
        label: "Save / load safety",
        prompt: `Do a Findings-only audit for save/load safety. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Focus on persistence risks, versioning issues, missing state, corrupted progression possibilities, and anything likely to break long-term player saves.`,
      },
      {
        label: "Multiplayer / shared-world readiness",
        prompt: `Review this for multiplayer or persistent-world risk. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Look for sync assumptions, authority confusion, timing issues, duplication exploits, and systems that may break when multiple players interact with them.`,
      },
    ],
  },
  {
    group: "Game-design audits",
    items: [
      {
        label: "Balance risk",
        prompt: `Do a Findings pass for balance risk. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Focus on exploits, dominant strategies, dead options, progression spikes, economy leaks, and systems that could make future balancing harder.`,
      },
      {
        label: "Economy health",
        prompt: `Do a Findings pass on economy health. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Focus on inflation risks, resource bottlenecks, item sinks, gold faucets, vendor abuse, crafting abuse, and progression distortions.`,
      },
      {
        label: "Abuse / exploit surface",
        prompt: `Read this as an exploit audit. No code changes. Dispatch in parallel to all relevant specialists (architect: server-authoritative core, reducers, world tick, op-resolver. frontend: legacy bundle, UI components, R3F surfaces, client state. art-director: asset pipeline, Pollinations, presentation. qa: test/smoke coverage, verification gaps, ship blockers. security: attacker's-perspective audit — auth gates, input validation, server-authority violations, race conditions, shared-state writes, attack surface), then synthesize into ONE integrated report. Cross-confirm findings between specialists where they overlap. Findings only. Flag loopholes, repeatable abuse patterns, reward duplication, bypasses, unintended stacking, and player behaviors that could trivialize progression.`,
      },
    ],
  },
];

// Angle add-ons. Picked from a separate dropdown and appended to the prompt.
export const ANGLES = [
  { label: "(no extra angle)", suffix: "" },
  { label: "Prioritize player pain over coding purity", suffix: "\n\nPrioritize findings by player pain, not coding purity." },
  { label: "Only issues that matter in real gameplay", suffix: "\n\nCall out only issues that are likely to matter in real gameplay." },
  { label: "Sort into ship-blocker / soon / later", suffix: "\n\nSeparate “ship blocker,” “soon,” and “later.”" },
  { label: "Player-facing vs developer-facing", suffix: "\n\nDistinguish between player-facing problems and developer-facing problems." },
  { label: "Skip style / architecture purity nitpicks", suffix: "\n\nDo not over-focus on style or architecture purity." },
  { label: "Assume actively developed game (not finished app)", suffix: "\n\nAssume this is an actively developed game system, not a finished enterprise app." },
];
