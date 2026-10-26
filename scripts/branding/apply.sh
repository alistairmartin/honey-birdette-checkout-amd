#!/usr/bin/env bash
# Checkout + customer account branding (shared by both surfaces).
#
#   scripts/branding/apply.sh <store> read           # print current branding
#   scripts/branding/apply.sh <store> apply <input>  # back up, then upsert <input>.json
#
# <store> is the myshopify domain. Targets that store's PUBLISHED checkout
# profile, or PROFILE_ID=<numeric id> to target a draft profile instead. Every apply first saves the current branding to backups/, so a
# change can be undone by re-applying the relevant parts of that file.
#
# One-time auth (opens a browser):
#   shopify store auth -s <store> --scopes read_checkout_branding_settings,write_checkout_branding_settings
set -euo pipefail

store="${1:?store domain required}"
action="${2:?read or apply}"
dir="$(cd "$(dirname "$0")" && pwd)"

profile_id="${PROFILE_ID:+gid://shopify/CheckoutProfile/${PROFILE_ID##*/}}"
[ -n "$profile_id" ] || profile_id="$(
  shopify store execute -s "$store" --no-input \
    -q 'query { checkoutProfiles(first: 1, query: "is_published:true") { nodes { id } } }' 2>/dev/null |
    grep -o 'gid://shopify/CheckoutProfile/[0-9]*' | head -1
)"
[ -n "$profile_id" ] || { echo "No published checkout profile found on $store" >&2; exit 1; }

read_branding() {
  shopify store execute -s "$store" --no-input \
    --query-file "$dir/read.graphql" -v "{\"id\":\"$profile_id\"}"
}

case "$action" in
  read)
    read_branding
    ;;
  apply)
    input="${3:?input JSON file required}"
    mkdir -p "$dir/backups"
    backup="$dir/backups/${store%%.*}-$(date +%Y%m%d-%H%M%S).json"
    read_branding > "$backup"
    echo "Backed up current branding to $backup"
    vars="$(python3 -c 'import json,sys; print(json.dumps({"id": sys.argv[1], "input": json.load(open(sys.argv[2]))}))' "$profile_id" "$input")"
    shopify store execute -s "$store" --no-input --allow-mutations \
      --query-file "$dir/upsert.graphql" -v "$vars"
    ;;
  *)
    echo "Unknown action: $action" >&2
    exit 1
    ;;
esac
