export const STAGE_EXECUTION_BUDGET_MS = 900_000;

export class StageContinuation extends Error {
  readonly code = "stage_continuation";

  constructor() {
    super("Completed batches are saved. Continuing automatically with the remaining work.");
  }
}
