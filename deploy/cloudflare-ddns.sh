#!/bin/sh
# Keeps an unproxied A record for the stream host pointed at this network's public IPv4.
# Replaces a CNAME (e.g. the old Cloudflare Tunnel route) on first run.
#
# Token: a Cloudflare API token with Zone → DNS → Edit on the zone, stored (chmod 600) in
#   ~/.config/simstream/cloudflare-token
set -eu
HOST=${SIMSTREAM_HOST:-simstream.sethwebster.com}
ZONE=${SIMSTREAM_ZONE:-sethwebster.com}
TOKEN=$(cat "$HOME/.config/simstream/cloudflare-token")
API=https://api.cloudflare.com/client/v4

cf() { curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
json() { /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

ip=$(curl -fsS -4 --max-time 10 https://api.ipify.org)
zone_id=$(cf "$API/zones?name=$ZONE" | json 'd["result"][0]["id"]')
record=$(cf "$API/zones/$zone_id/dns_records?name=$HOST")
type=$(echo "$record" | json 'd["result"][0]["type"] if d["result"] else ""')
id=$(echo "$record" | json 'd["result"][0]["id"] if d["result"] else ""')
content=$(echo "$record" | json 'd["result"][0]["content"] if d["result"] else ""')
proxied=$(echo "$record" | json 'str(d["result"][0]["proxied"]).lower() if d["result"] else ""')

body="{\"type\":\"A\",\"name\":\"$HOST\",\"content\":\"$ip\",\"ttl\":60,\"proxied\":false}"
if [ "$type" = "A" ] && [ "$content" = "$ip" ] && [ "$proxied" = "false" ]; then
  exit 0
elif [ "$type" = "A" ]; then
  cf -X PUT "$API/zones/$zone_id/dns_records/$id" --data "$body" >/dev/null
  echo "$(date '+%F %T') $HOST: A $content -> $ip"
else
  [ -n "$id" ] && cf -X DELETE "$API/zones/$zone_id/dns_records/$id" >/dev/null && echo "$(date '+%F %T') $HOST: removed $type $content"
  cf -X POST "$API/zones/$zone_id/dns_records" --data "$body" >/dev/null
  echo "$(date '+%F %T') $HOST: A $ip (unproxied)"
fi
