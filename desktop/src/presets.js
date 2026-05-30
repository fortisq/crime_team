// Universal preset library. Every new group is seeded with a copy of this
// at create time (~/.crime-team/groups/<id>/presets.json) so it's editable
// per-project. Until you customize a group's file, it falls through to this
// bundled set.
//
// Editing this file changes the *bundled fallback*, not any existing group's
// already-seeded presets — those live on disk under ~/.crime-team/groups/.

export const PRESETS = [
  {
    group: "Findings (universal)",
    items: [
      {
        label: "Universal Findings — what hurts users & dev",
        prompt:
`Do a read-only Findings pass on this system. No code changes. Judge it from two angles:
1. Will this hurt the user experience?
2. Will this slow development later?

Report only the highest-value findings. Ignore minor style issues unless they create real risk. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report. Cite specific file:line references — they'll be verified automatically.`,
      },
      {
        label: "Universal Findings — sharp 5-section version",
        prompt:
`Do a read-only review only. No code changes, no rewrites, no patches. Findings report with:
1. What's working well
2. Risks / weak spots
3. User impact
4. Dev-time impact
5. Top 5 highest-value improvements to consider later

Prefer practical findings over style nitpicks. Focus on issues that matter during active development. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "First impressions — what would a new dev hit on day one?",
        prompt:
`Imagine a competent new contributor cloning this repo for the first time. Read it through their eyes. No code changes. Findings only. Cover: setup friction, mental-model confusion, where docs lie or are stale, what would block their first useful PR, and what they'd spend a frustrated afternoon on. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
    ],
  },

  {
    group: "Safety & correctness",
    items: [
      {
        label: "Security audit — attacker's perspective",
        prompt:
`Audit this from an attacker's perspective. No code changes. Findings only. Focus on: auth boundaries, input validation gaps at the system boundary, server-authority violations, secret handling, injection surfaces, race conditions on shared state, and abuse vectors a malicious user could chain. Mark each finding by exploitability + blast radius. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Bug-prone design",
        prompt: `Read this as a bug-risk audit. No code changes. Findings only. Flag brittle logic, edge cases, state desync risks, unclear ownership, hidden dependencies, and places likely to produce hard-to-repro bugs. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Race conditions & concurrency",
        prompt:
`Audit shared state and concurrency. No code changes. Findings only. Focus on: read-modify-write hazards without locks, double-spend / double-grant patterns, async ordering assumptions, optimistic-UI desync, missing transaction boundaries, retry idempotency. Cite the specific shared resource each finding touches. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Error handling & crash recovery",
        prompt:
`Findings-only audit of error handling. No code changes. Look for: swallowed exceptions, unhandled promise rejections, partial-failure states, retry-without-backoff loops, error paths that lose user work, lack of crash recovery on restart, missing or misleading user-facing error messages. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Data integrity & migration risk",
        prompt:
`Audit data integrity. No code changes. Findings only. Cover: schema drift, missing validation at the persistence boundary, migrations that aren't reversible or idempotent, foreign-key gaps, fields with no enforced shape, unclear ownership of writes. Call out anything that could leave the DB in a wedged state. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
    ],
  },

  {
    group: "Quality & polish",
    items: [
      {
        label: "Performance hotspots",
        prompt: `Do a Findings-only performance audit. No code changes. Focus on likely hotspots, repeated work, unnecessary refreshes, heavy loops, memory churn, and systems that may scale badly with more content or users. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Accessibility & keyboard nav",
        prompt:
`Audit accessibility. No code changes. Findings only. Focus on: keyboard reachability, focus management, semantic HTML / ARIA, contrast, screen-reader signals, motion sensitivity, untrapped focus in modals, controls reachable only by mouse. Skip if this isn't a UI project — return "N/A: not a UI surface". Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Test coverage gaps",
        prompt:
`Findings-only audit of test coverage. No code changes. Identify: untested critical paths, missing edge-case tests, tests that pass for the wrong reason (no real assertions / mocked-everything), invariant checks that aren't tested, regression risk areas. Suggest the highest-leverage tests to add. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Logging & observability gaps",
        prompt:
`Audit logging and observability. No code changes. Findings only. Cover: silent failure modes, missing structured-log context, log levels misused, sensitive data leaked in logs, lack of correlation / request ids, blind spots that would make a production incident hard to debug. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Maintainability",
        prompt: `Review this for maintainability during active development. No code changes. Findings only. Highlight complexity, duplication, unclear responsibilities, naming confusion, and areas that will slow future feature work. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
    ],
  },

  {
    group: "Interfaces & surfaces",
    items: [
      {
        label: "API surface review",
        prompt:
`Audit every public API / boundary surface. No code changes. Findings only. Cover: boundary validation completeness, type safety holes, undocumented invariants callers rely on, asymmetric contracts (e.g. accepts X but returns Y-shaped), versioning footguns, dispatch surfaces that should require auth and don't. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Onboarding & first-use UX",
        prompt: `Audit this for first-time user onboarding. No code changes. Findings only. Identify confusion points, missing feedback, friction, and places where new users may quit or get lost. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Documentation gaps",
        prompt:
`Findings-only audit of internal docs. No code changes. Cover: docs that are stale vs the code they describe, undocumented invariants that bite, missing decision-rationale ("why" not "what"), broken links / dead pointers, sections that read fine but answer the wrong question. Note where adding 5 minutes of docs would save hours later. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
    ],
  },

  {
    group: "Dependencies & supply chain",
    items: [
      {
        label: "Dependency review",
        prompt:
`Audit dependencies. No code changes. Findings only. Cover: known-CVE / abandoned packages, dependencies pulled in for trivial reasons, version pins that have drifted, packages with surprising transitive risk (giant install footprint, native modules, postinstall scripts), dev vs runtime placement errors. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
    ],
  },
];

export const ANGLES = [
  { label: "(no extra angle)", suffix: "" },
  { label: "Prioritize user pain over coding purity", suffix: "\n\nPrioritize findings by user pain, not coding purity." },
  { label: "Only issues that matter in real use", suffix: "\n\nCall out only issues that are likely to matter in real use." },
  { label: "Sort into ship-blocker / soon / later", suffix: "\n\nSeparate “ship blocker,” “soon,” and “later.”" },
  { label: "User-facing vs developer-facing", suffix: "\n\nDistinguish between user-facing problems and developer-facing problems." },
  { label: "Skip style / architecture purity nitpicks", suffix: "\n\nDo not over-focus on style or architecture purity." },
  { label: "Top 3 only — surgical", suffix: "\n\nReport only the top 3 highest-value findings. Skip everything else." },
  { label: "Add concrete repro for each finding", suffix: "\n\nFor each finding, include the shortest possible repro (steps or code path)." },
];
