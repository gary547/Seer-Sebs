export function canonicalProjectVolumeCte(keptOnly = false): string {
  const qualification = keptOnly ? "AND keyword.detox_status = 'keep'" : "";
  return `imported_volume AS (
    SELECT DISTINCT ON (volume.keyword_id, volume.month)
      volume.keyword_id, volume.month, volume.volume
    FROM keyword_monthly_volumes AS volume
    JOIN keywords AS keyword ON keyword.id = volume.keyword_id
    WHERE keyword.project_id = $1 ${qualification}
    ORDER BY volume.keyword_id, volume.month,
      volume.fetched_at DESC, volume.source DESC, volume.id DESC
  ), canonical_volume AS (
    SELECT keyword_id, month, volume FROM imported_volume
    UNION ALL
    SELECT keyword.id AS keyword_id, provider.month, provider.volume
    FROM keywords AS keyword
    JOIN local_provider_keyword_monthly_volumes AS provider
      ON provider.project_id = keyword.project_id
      AND provider.normalised_keyword = keyword.normalised_keyword
    WHERE keyword.project_id = $1 ${qualification}
      AND NOT EXISTS (
        SELECT 1 FROM imported_volume AS imported
        WHERE imported.keyword_id = keyword.id AND imported.month = provider.month
      )
  )`;
}
