#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ -z "${SEER_SOURCE_DATABASE_URL:-}" ]]; then
  echo "SEER_SOURCE_DATABASE_URL is required." >&2
  exit 1
fi

output_directory="${1:-migration-evidence/source-dump}"
if [[ -d "$output_directory" ]] && [[ -n "$(find "$output_directory" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Refusing to overwrite non-empty output directory: $output_directory" >&2
  exit 1
fi
mkdir -p "$output_directory"

pg_dump \
  --dbname="$SEER_SOURCE_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --schema=public \
  --file="$output_directory/public.dump"

pg_dump \
  --dbname="$SEER_SOURCE_DATABASE_URL" \
  --format=custom \
  --data-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  --file="$output_directory/public-data.dump"

pg_dump \
  --dbname="$SEER_SOURCE_DATABASE_URL" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  --file="$output_directory/public-schema.sql"

pg_dump \
  --dbname="$SEER_SOURCE_DATABASE_URL" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  --schema=auth \
  --schema=storage \
  --file="$output_directory/effective-source-schema.sql"

pg_restore --list "$output_directory/public.dump" \
  > "$output_directory/public-archive-contents.txt"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum \
    "$output_directory/public.dump" \
    "$output_directory/public-data.dump" \
    "$output_directory/public-schema.sql" \
    "$output_directory/effective-source-schema.sql" \
    "$output_directory/public-archive-contents.txt" \
    > "$output_directory/SHA256SUMS"
else
  shasum -a 256 \
    "$output_directory/public.dump" \
    "$output_directory/public-data.dump" \
    "$output_directory/public-schema.sql" \
    "$output_directory/effective-source-schema.sql" \
    "$output_directory/public-archive-contents.txt" \
    > "$output_directory/SHA256SUMS"
fi

chmod 600 "$output_directory"/*

echo "Source dump captured in $output_directory."
