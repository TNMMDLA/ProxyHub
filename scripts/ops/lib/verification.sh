#!/usr/bin/env bash

if [[ -n "${PROXYHUB_OPS_VERIFICATION_LOADED:-}" ]]; then
  return 0
fi
readonly PROXYHUB_OPS_VERIFICATION_LOADED=1

proxyhub_compose_service_container_id() {
  local compose_command="$1"
  local service="$2"
  local quiet="${3:-false}"
  local ids count
  ids="$("$compose_command" ps -q --all "$service" 2>/dev/null || true)"
  ids="$(tr -d '\r' <<<"$ids" | awk 'NF')"
  count="$(awk 'NF { count += 1 } END { print count + 0 }' <<<"$ids")"
  if [[ "$count" != "1" ]]; then
    if [[ "$quiet" != "true" ]]; then
      if [[ "$count" == "0" ]]; then
        printf 'OPS_CONTAINER_NOT_FOUND: Compose service %s did not resolve to a container\n' \
          "$service" >&2
      else
        printf 'OPS_CONTAINER_AMBIGUOUS: Compose service %s resolved to %s containers\n' \
          "$service" "$count" >&2
      fi
    fi
    return 1
  fi
  printf '%s\n' "$ids"
}

proxyhub_health_data() {
  local data
  if ! data="$(jq -ce '
    if .success == true and (.data | type == "object")
    then .data
    else .
    end
    | select(type == "object")
  ')"; then
    printf 'OPS_HEALTH_PAYLOAD_INVALID: Health response is not valid JSON metadata\n' >&2
    return 1
  fi
  printf '%s\n' "$data"
}

proxyhub_health_metadata_valid() {
  local payload="$1"
  local expected_version="${2:-}"
  local expected_sha="${3:-}"
  local expected_environment="${4:-}"
  local expected_mode="${5:-}"
  if ! jq -e \
    --arg version "$expected_version" \
    --arg sha "$expected_sha" \
    --arg environment "$expected_environment" \
    --arg mode "$expected_mode" '
      .status == "ok" and
      (.version | type == "string" and length > 0) and
      (.gitSha | type == "string" and length > 0) and
      (.buildEnvironment | type == "string" and length > 0) and
      (.deployMode | type == "string" and length > 0) and
      ($version == "" or .version == $version) and
      ($sha == "" or .gitSha == $sha) and
      ($environment == "" or .buildEnvironment == $environment) and
      ($mode == "" or .deployMode == $mode)
    ' >/dev/null <<<"$payload"; then
    printf 'OPS_HEALTH_METADATA_INVALID: Health metadata is missing or does not match\n' >&2
    return 1
  fi
}

proxyhub_caddy_logs_have_explicit_failure() {
  local line json level lowered
  while IFS= read -r line; do
    if [[ "$line" == *'{'* ]]; then
      json="{${line#*\{}"
      if jq -e . >/dev/null 2>&1 <<<"$json"; then
        level="$(jq -r '.level // empty' <<<"$json")"
        [[ "${level,,}" == "error" ]] && return 0
        continue
      fi
    fi
    lowered="${line,,}"
    case "$lowered" in
      *"challenge failed"* | *"dns problem"* | *"address already in use"* | \
        *"unable to obtain certificate"* | *"certificate issuance failed"* | \
        *"no valid ip addresses"*) return 0 ;;
    esac
  done
  return 1
}
