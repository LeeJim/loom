#!/usr/bin/env bash
# Installed once as /usr/local/sbin/loom-release by the host operator.
set -euo pipefail
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset CDPATH BASH_ENV ENV GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM
read -r requested
[[ "$requested" =~ ^[a-f0-9]{40}$ ]]

root=/opt/ai-native
releases="$root/loom-releases"
install -d -o root -g root -m 0755 "$releases"
exec 9>"$releases/.lock"
flock -w 30 9

checkout="$(mktemp -d "$releases/.checkout.XXXXXX")"
trap 'rm -rf -- "$checkout"' EXIT
git -C "$checkout" init -q
git -C "$checkout" fetch --no-tags --depth=1 https://github.com/LeeJim/loom.git refs/heads/main
[[ "$(git -C "$checkout" rev-parse FETCH_HEAD)" == "$requested" ]] || {
  echo "The requested revision is no longer at the tip of Loom main." >&2
  exit 1
}
git -C "$checkout" checkout --detach --quiet FETCH_HEAD
python3 -I "$checkout/deploy/rollout.py" "$checkout" "$requested"
