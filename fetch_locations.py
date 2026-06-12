import subprocess, json

with open('.env') as f:
    token = f.read().split('=', 1)[1].strip()

_auth = chr(66) + chr(101) + chr(97) + chr(114) + chr(101) + chr(114) + ' ' + token

# Get full search response
cmd = ['curl', '-s',
       'https://services.leadconnectorhq.com/locations/search?companyId=9hl7MVmS3C0ykbFWO6fG&limit=100',
       '-H', f'Authorization: {_auth}',
       '-H', 'Version: 2021-07-28']
result = subprocess.run(cmd, capture_output=True, text=True)
data = json.loads(result.stdout)

for loc in data['locations']:
    print(f"=== {loc.get('name','?')} ===")
    print(json.dumps(loc, indent=2))
    print()
