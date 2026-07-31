// Shared calc_run_registry status vocabulary.
// Must stay aligned with public.calc_run_registry_status_check:
// queued | running | succeeded | failed | partial

export const CALC_RUN_SUCCESS_STATUS = "succeeded" as const;
export const CALC_RUN_FAILED_STATUS = "failed" as const;
export const CALC_RUN_PARTIAL_STATUS = "partial" as const;

export type CalcRunTerminalStatus =
  | typeof CALC_RUN_SUCCESS_STATUS
  | typeof CALC_RUN_FAILED_STATUS
  | typeof CALC_RUN_PARTIAL_STATUS;
