// Universal fallback preset library. Used only when a group has no presets.json
// of its own at ~/.crime-team/groups/<group-id>/presets.json.
//
// Each project group's real presets live in that JSON file — edit those for
// project-specific prompts. These bundled defaults are intentionally generic
// so they apply to any new project the wizard creates.

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
    ],
  },
  {
    group: "Specific audits",
    items: [
      {
        label: "Bug-prone design",
        prompt: `Read this as a bug-risk audit. No code changes. Findings only. Flag brittle logic, edge cases, state desync risks, unclear ownership, hidden dependencies, and places likely to produce hard-to-repro bugs. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Performance hotspots",
        prompt: `Do a Findings-only performance audit. No code changes. Focus on likely hotspots, repeated work, unnecessary refreshes, heavy loops, memory churn, and systems that may scale badly with more content or users. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Maintainability",
        prompt: `Review this for maintainability during active development. No code changes. Findings only. Highlight complexity, duplication, unclear responsibilities, naming confusion, and areas that will slow future feature work. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
      },
      {
        label: "Onboarding & first-use UX",
        prompt: `Audit this for first-time user onboarding. No code changes. Findings only. Identify confusion points, missing feedback, friction, and places where new users may quit or get lost. Dispatch in parallel to every relevant specialist; synthesize into ONE integrated report.`,
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
];
