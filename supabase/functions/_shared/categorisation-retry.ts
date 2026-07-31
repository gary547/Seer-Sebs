export type CategorisationRetryDisposition =
  | "fallback"
  | "retry_consumed"
  | "retry_unconsumed";

export type EmptyCategorisationClaimDisposition = "done" | "waiting" | "error";

export function categorisationRetryDisposition(
  attempts: number,
  aiAttempted: boolean,
): CategorisationRetryDisposition {
  if (!aiAttempted) return "retry_unconsumed";
  if (attempts >= 4) return "fallback";
  return "retry_consumed";
}

export function emptyCategorisationClaimDisposition(
  remaining: number,
  processing: number,
): EmptyCategorisationClaimDisposition {
  if (remaining === 0) return "done";
  if (processing > 0) return "waiting";
  return "error";
}
