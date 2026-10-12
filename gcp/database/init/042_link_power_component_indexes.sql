CREATE INDEX CONCURRENTLY IF NOT EXISTS serp_results_link_power_components_idx
  ON serp_results (id)
  INCLUDE (domain, is_client_domain, rank_absolute, url_rating, domain_rating,
    referring_domains, backlinks);

CREATE INDEX CONCURRENTLY IF NOT EXISTS serp_results_project_domain_idx
  ON serp_results (project_id, domain, id) INCLUDE (rank_absolute);

INSERT INTO schema_migrations (version)
VALUES ('042_link_power_component_indexes')
ON CONFLICT (version) DO NOTHING;
