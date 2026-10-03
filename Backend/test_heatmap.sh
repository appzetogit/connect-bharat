#!/bin/bash
set -u
API="https://bharat.buytogetherindia.com/api/v1"
PHONE="${1:-7470311228}"

curl -s -X POST "$API/drivers/auth/send-otp" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"countryCode\":\"+91\"}" > /dev/null
RESP=$(curl -s -X POST "$API/drivers/auth/verify-otp" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"countryCode\":\"+91\",\"otp\":\"0000\"}")
TOK=$(echo "$RESP" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$TOK" ]; then echo "login failed: $(echo "$RESP" | head -c 200)"; exit 1; fi
echo "driver token acquired"

echo
echo "== GET /drivers/heatmap (Indore) =="
curl -s "$API/drivers/heatmap?lat=22.7282&lng=75.8843&radius=8" \
  -H "Authorization: Bearer $TOK" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('success   :', d.get('success'))
print('updatedAt :', d.get('updatedAt'))
print('config    :', json.dumps(d.get('config')))
zones = d.get('zones') or []
print('zones     :', len(zones))
for z in zones[:6]:
    print('   %-16s %-6s score=%-6s requests=%-3s drivers=%-3s center=%.4f,%.4f corners=%d' % (
        z['id'], z['level'], z['demandScore'], z['requestCount'],
        z['availableDrivers'], z['center']['lat'], z['center']['lng'], len(z['polygon'])))
if zones:
    print()
    print('sample zone json:')
    print(json.dumps(zones[0], indent=2)[:600])
"
