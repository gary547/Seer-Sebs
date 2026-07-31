#!/usr/bin/env bash
set -euo pipefail

project_id="${SEER_FIREBASE_PROJECT_ID:-}"
site_id="${SEER_FIREBASE_SITE_ID:-}"
channel="${SEER_FIREBASE_CHANNEL:-live}"
target="web"

if [[ ! "${project_id}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "SEER_FIREBASE_PROJECT_ID is invalid." >&2
  exit 1
fi

if [[ ! "${site_id}" =~ ^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$ ]]; then
  echo "SEER_FIREBASE_SITE_ID is invalid." >&2
  exit 1
fi

if [[ ! "${channel}" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; then
  echo "SEER_FIREBASE_CHANNEL is invalid." >&2
  exit 1
fi

firebase target:apply hosting "${target}" "${site_id}" \
  --project "${project_id}" \
  --non-interactive

if [[ "${channel}" == "live" ]]; then
  exec firebase deploy \
    --project "${project_id}" \
    --only "hosting:${target}" \
    --non-interactive \
    --message "Cloud Build ${BUILD_ID:-manual}"
fi

exec firebase hosting:channel:deploy "${channel}" \
  --project "${project_id}" \
  --only "${target}" \
  --expires 7d \
  --non-interactive
