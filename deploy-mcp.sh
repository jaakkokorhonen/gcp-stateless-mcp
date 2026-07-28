#!/usr/bin/env bash
set -euo pipefail

# Auth-tarkistus
gcloud projects describe uutisseuranta-activitystreams --quiet > /dev/null 2>&1 || {
  echo "ERROR: gcloud auth or project access failed." \
       "Run: gcloud auth login  OR  set GOOGLE_APPLICATION_CREDENTIALS" >&2
  exit 1
}

IMAGE="europe-north1-docker.pkg.dev/uutisseuranta-activitystreams/mcp-servers/gcp-mcp"
SHA=$(git rev-parse --short=12 HEAD 2>/dev/null || echo "no-git-sha")

: "${ALLOWED_ORIGIN:=*}"

gcloud builds submit . \
  --tag "$IMAGE:$SHA" \
  --timeout=600 \
  --machine-type=e2-highcpu-8 \
  --project uutisseuranta-activitystreams

gcloud artifacts docker tags add \
  "$IMAGE:$SHA" \
  "$IMAGE:latest" \
  --project uutisseuranta-activitystreams

ENV="${ENV:-dev}"
MIN_INSTANCES=$( [ "$ENV" = "prod" ] && echo 1 || echo 0 )

# Päivitä service.yaml image-tagi ja deployaa probet mukaan
cp service.yaml service.yaml.deploy
sed -i.bak "s|:latest|:$SHA|g" service.yaml.deploy && rm service.yaml.deploy.bak

gcloud run services replace service.yaml.deploy \
  --region europe-north1 \
  --project uutisseuranta-activitystreams

# Päivitä env-muuttujat ja scaling erikseen
gcloud run services update mcp-gcp-server \
  --set-env-vars="DEPLOY_SHA=$SHA,ALLOWED_ORIGIN=$ALLOWED_ORIGIN" \
  --concurrency 10 \
  --min-instances "$MIN_INSTANCES" \
  --max-instances 3 \
  --region europe-north1 \
  --project uutisseuranta-activitystreams

rm service.yaml.deploy
