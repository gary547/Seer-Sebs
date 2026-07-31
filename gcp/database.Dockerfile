FROM gcr.io/cloud-sql-connectors/cloud-sql-proxy@sha256:54e23cad9aeeedbf88ab75f993146631b878035f702b31c51885a932e0c7286c AS cloud-sql-proxy

FROM postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193

COPY --from=cloud-sql-proxy /cloud-sql-proxy /usr/local/bin/cloud-sql-proxy
COPY gcp/database/init /migrations
COPY gcp/database/bootstrap/010_bind_runtime_iam.sql /bootstrap/010_bind_runtime_iam.sql
COPY gcp/database/bootstrap/apply-target-schema.sh /usr/local/bin/apply-target-schema

RUN chmod 0555 /usr/local/bin/cloud-sql-proxy /usr/local/bin/apply-target-schema

USER postgres

ENTRYPOINT ["/usr/local/bin/apply-target-schema"]
