export const PIPELINE_STAGE_IDS = [
  "intake",
  "gsc-promotion",
  "detox",
  "preflight",
  "categorisation",
  "brand-classification",
  "keyword-enrichment",
  "clustering",
  "historical-volume",
  "ranking-url",
  "gsc-intent",
  "serp-collection",
  "authority",
  "backlinks",
  "site-architecture",
  "link-power-score",
  "demand-signals",
  "ctr-curves",
  "har-readiness",
  "har-v2",
  "revenue-readiness",
  "revenue-v2",
  "calibration",
  "rollup-output",
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];

export type PipelineExecutionKind = "api" | "job" | "tasks";

export interface PipelineStageDefinition {
  dependencies: readonly PipelineStageId[];
  execution: PipelineExecutionKind;
  id: PipelineStageId;
}

export const PIPELINE_STAGES: readonly PipelineStageDefinition[] = [
  { id: "intake", dependencies: [], execution: "api" },
  { id: "gsc-promotion", dependencies: ["intake"], execution: "job" },
  { id: "detox", dependencies: ["gsc-promotion"], execution: "tasks" },
  { id: "preflight", dependencies: ["detox"], execution: "job" },
  { id: "categorisation", dependencies: ["detox"], execution: "tasks" },
  { id: "brand-classification", dependencies: ["preflight"], execution: "tasks" },
  { id: "keyword-enrichment", dependencies: ["preflight"], execution: "tasks" },
  { id: "clustering", dependencies: ["keyword-enrichment"], execution: "job" },
  { id: "historical-volume", dependencies: ["keyword-enrichment"], execution: "tasks" },
  { id: "ranking-url", dependencies: ["preflight"], execution: "tasks" },
  { id: "gsc-intent", dependencies: ["preflight"], execution: "tasks" },
  { id: "serp-collection", dependencies: ["clustering"], execution: "tasks" },
  { id: "authority", dependencies: ["serp-collection"], execution: "tasks" },
  { id: "backlinks", dependencies: ["authority"], execution: "tasks" },
  {
    id: "site-architecture",
    dependencies: ["ranking-url"],
    execution: "tasks",
  },
  {
    id: "link-power-score",
    dependencies: ["authority", "backlinks"],
    execution: "job",
  },
  {
    id: "demand-signals",
    dependencies: ["keyword-enrichment", "historical-volume"],
    execution: "job",
  },
  {
    id: "ctr-curves",
    dependencies: ["brand-classification", "gsc-intent"],
    execution: "job",
  },
  {
    id: "har-readiness",
    dependencies: ["ranking-url", "site-architecture", "link-power-score", "serp-collection"],
    execution: "job",
  },
  {
    id: "har-v2",
    dependencies: [
      "har-readiness",
      "ranking-url",
      "site-architecture",
      "link-power-score",
      "clustering",
      "keyword-enrichment",
      "brand-classification",
      "serp-collection",
    ],
    execution: "job",
  },
  {
    id: "revenue-readiness",
    dependencies: ["har-v2", "demand-signals", "ctr-curves"],
    execution: "job",
  },
  {
    id: "revenue-v2",
    dependencies: [
      "revenue-readiness",
      "har-v2",
      "demand-signals",
      "ctr-curves",
      "ranking-url",
    ],
    execution: "job",
  },
  { id: "calibration", dependencies: ["revenue-v2"], execution: "job" },
  {
    id: "rollup-output",
    dependencies: [
      "calibration",
      "revenue-v2",
      "categorisation",
      "clustering",
      "demand-signals",
      "ranking-url",
    ],
    execution: "job",
  },
];
