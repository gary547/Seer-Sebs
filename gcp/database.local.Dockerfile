FROM postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193

COPY gcp/database/init /docker-entrypoint-initdb.d
COPY gcp/database/local/999_local_runtime_users.sql /docker-entrypoint-initdb.d/999_local_runtime_users.sql
