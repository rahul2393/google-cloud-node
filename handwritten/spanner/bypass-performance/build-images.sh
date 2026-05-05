#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_REPO="${IMAGE_REPO:-us-central1-docker.pkg.dev/span-cloud-testing/irahul-images/irahul-node-client}"
RELEASE_A="${RELEASE_A:-8.6.0}"
RELEASE_B="${RELEASE_B:-8.2.2}"
CURRENT_TAG="${CURRENT_TAG:-current}"
SHA_TAG="current-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
PUSH="${PUSH:-true}"
PLATFORM="${PLATFORM:-linux/amd64}"

build_and_maybe_push() {
  local mode="$1"
  local version="$2"
  local tag1="$3"
  local tag2="$4"
  echo "Building ${IMAGE_REPO}:${tag1} mode=${mode} version=${version}"
  local target="runtime-local"
  local extra_args=()
  if [[ "$mode" == "npm" ]]; then
    target="runtime-npm"
    extra_args+=(--build-arg "SPANNER_VERSION=$version")
  fi
  docker build \
    --platform "$PLATFORM" \
    -f "$ROOT/Dockerfile" \
    --target "$target" \
    "${extra_args[@]}" \
    -t "${IMAGE_REPO}:${tag1}" \
    -t "${IMAGE_REPO}:${tag2}" \
    "$ROOT"
  if [[ "$PUSH" == "true" ]]; then
    docker push "${IMAGE_REPO}:${tag1}"
    docker push "${IMAGE_REPO}:${tag2}"
  fi
}

build_and_maybe_push local local "$CURRENT_TAG" "$SHA_TAG"
build_and_maybe_push npm "$RELEASE_A" release-a "release-${RELEASE_A}"
build_and_maybe_push npm "$RELEASE_B" release-b "release-${RELEASE_B}"

cat <<MSG
Done.
Kubernetes manifest expects:
  ${IMAGE_REPO}:current
  ${IMAGE_REPO}:release-a
  ${IMAGE_REPO}:release-b
Override manifest image repo if needed:
  perl -pi -e 's#us-central1-docker.pkg.dev/span-cloud-testing/irahul-images/irahul-node-client#${IMAGE_REPO}#g' k8s/stale_query_compare.yaml
MSG
