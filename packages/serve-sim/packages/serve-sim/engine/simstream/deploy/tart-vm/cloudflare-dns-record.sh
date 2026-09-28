set -e
TOK=$(cat ~/.config/simstream/cloudflare-token); API=https://api.cloudflare.com/client/v4
Z=$(curl -fsS -H "Authorization: Bearer $TOK" "$API/zones?name=sethwebster.com" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"][0]["id"])')
IP=$(curl -fsS -4 https://api.ipify.org)
EX=$(curl -fsS -H "Authorization: Bearer $TOK" "$API/zones/$Z/dns_records?name=vm.simstream.sethwebster.com" | python3 -c 'import json,sys;r=json.load(sys.stdin)["result"];print(r[0]["id"] if r else "")')
BODY="{\"type\":\"A\",\"name\":\"vm.simstream.sethwebster.com\",\"content\":\"$IP\",\"ttl\":60,\"proxied\":false}"
if [ -n "$EX" ]; then curl -fsS -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "$API/zones/$Z/dns_records/$EX" --data "$BODY" >/dev/null
else curl -fsS -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "$API/zones/$Z/dns_records" --data "$BODY" >/dev/null; fi
echo "DNS vm.simstream.sethwebster.com -> home IP (unproxied)"
