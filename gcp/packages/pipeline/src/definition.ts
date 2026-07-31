export const PIPELINE_STAGE_IDS = [
  "intake",
  "gsc-promotion",
  "detox",
  "categorisation",
  "brand-classification",
  "keyword-enrichment",
  "ranking-url",
  "gsc-intent",
  "serp-collection",
  "authority",
  "backlinks",
  "site-architecture",
  "link-power-score",
  "demand-signals",
  "ctr-curves",
  "clustering",
  "har-v2",
  "revenue-v2",
  "calibration",
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
  { id: "categorisation", dependencies: ["detox"], execution: "tasks" },
  { id: "brand-classification", dependencies: ["gsc-promotion"], execution: "tasks" },
  { id: "keyword-enrichment", dependencies: ["categorisation"], execution: "tasks" },
  { id: "ranking-url", dependencies: ["categorisation"], execution: "tasks" },
  { id: "gsc-intent", dependencies: ["categorisation"], execution: "tasks" },
  { id: "serp-collection", dependencies: ["keyword-enrichment"], execution: "tasks" },
  { id: "authority", dependencies: ["serp-collection"], execution: "tasks" },
  { id: "backlinks", dependencies: ["authority"], execution: "tasks" },
  {
    id: "site-architecture",
    dependencies: ["keyword-enrichment", "ranking-url"],
    execution: "tasks",
  },
  {
    id: "link-power-score",
    dependencies: ["authority", "backlinks"],
    execution: "job",
  },
  { id: "demand-signals", dependencies: ["keyword-enrichment"], execution: "job" },
  {
    id: "ctr-curves",
    dependencies: ["brand-classification", "gsc-intent"],
    execution: "job",
  },
  {
    id: "clustering",
    dependencies: ["keyword-enrichment", "serp-collection"],
    execution: "job",
  },
  {
    id: "har-v2",
    dependencies: [
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
    id: "revenue-v2",
    dependencies: [
      "har-v2",
      "demand-signals",
      "ctr-curves",
      "categorisation",
      "ranking-url",
    ],
    execution: "job",
  },
  { id: "calibration", dependencies: ["revenue-v2"], execution: "job" },
];
