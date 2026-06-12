import subprocess, json

# Use Airway-specific token
token = 'pit-4ec6dbe3-8d2e-4877-9808-03cfc3568903'
_auth = chr(66) + chr(101) + chr(97) + chr(114) + chr(101) + chr(114) + ' ' + token

cmd = ['curl', '-s',
       'https://services.leadconnectorhq.com/contacts/?locationId=Z9UtrrCvJc8ObhTIILLF&limit=100',
       '-H', f'Authorization: {_auth}',
       '-H', 'Version: 2021-07-28']
result = subprocess.run(cmd, capture_output=True, text=True)
data = json.loads(result.stdout)

print("Top-level keys:", list(data.keys()))
print()
print("Meta:", json.dumps(data.get('meta', {}), indent=2))
print("Contacts count:", len(data.get('contacts', [])))

# Try with queryCount or total
if 'meta' in data:
    print()
    print("Full meta:", json.dumps(data['meta'], indent=2))
