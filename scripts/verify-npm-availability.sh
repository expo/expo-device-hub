#!/usr/bin/env bash
set -euo pipefail

# Based on the exact-version availability check in expo/eas-cli's release.yml.
# npm can serve version metadata before it serves the corresponding tarball.
manifest=$1
if [[ ! -s "$manifest" ]]; then
  echo "No release packages to verify." >&2
  exit 1
fi

deadline=$((SECONDS + 1800))
while IFS= read -r spec; do
  version=${spec##*@}
  while true; do
    published=$(npm view "$spec" version --prefer-online 2>/dev/null || true)
    if [[ "$published" == "$version" ]]; then
      tarball=$(npm view "$spec" dist.tarball --prefer-online 2>/dev/null || true)
      if [[ -n "$tarball" ]] && curl --fail --silent --show-error --location --max-time 60 --output /dev/null "$tarball"; then
        echo "Verified $spec is available on npm."
        break
      fi
    fi

    remaining=$((deadline - SECONDS))
    if ((remaining <= 0)); then
      echo "$spec was not available on npm after 1800s." >&2
      exit 1
    fi
    delay=$((remaining < 10 ? remaining : 10))
    echo "$spec is not available on npm yet. Retrying in ${delay}s."
    sleep "$delay"
  done
done < "$manifest"
