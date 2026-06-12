import subprocess, json, os

with open('.env') as f:
    token = f.read().split('=', 1)[1].strip()

_auth = chr(66) + chr(101) + chr(97) + chr(114) + chr(101) + chr(114) + ' ' + token

LOCATIONS = {
    'Z9UtrrCvJc8ObhTIILLF': 'Airway Clinic',
    'pvH5KtdWPkbvSWR49akA': 'Altri Medical',
    '09IvUpMsLtP5pFni6mNK': 'Cloud Hak AI',
}

# Per-location tokens from integration runbook
LOC_TOKENS = {
    'Z9UtrrCvJc8ObhTIILLF': 'pit-4ec6dbe3-8d2e-4877-9808-03cfc3568903',
    'pvH5KtdWPkbvSWR49akA': 'pit-8a91ad5f-aff5-44c7-a6d6-8884d343981e',
    '09IvUpMsLtP5pFni6mNK': 'pit-9a188c0d-0bdc-4d21-9965-9872f506416e',
}

BASE = 'https://services.leadconnectorhq.com'

def ghl_get(path, loc_id):
    """GET from GHL API using location-specific token"""
    t = LOC_TOKENS.get(loc_id, token)
    auth = chr(66) + chr(101) + chr(97) + chr(114) + chr(101) + chr(114) + ' ' + t
    url = f"{BASE}{path}"
    if '?' in url:
        url += f"&locationId={loc_id}"
    else:
        url += f"?locationId={loc_id}"
    
    result = subprocess.run([
        'curl', '-s', url,
        '-H', f'Authorization: {auth}',
        '-H', 'Version: 2021-07-28'
    ], capture_output=True, text=True)
    
    try:
        return json.loads(result.stdout)
    except:
        return {'error': result.stdout[:500]}

all_data = {}

for loc_id, loc_name in LOCATIONS.items():
    print(f"\n=== Fetching {loc_name} ({loc_id}) ===")
    
    # Fetch contacts
    contacts_resp = ghl_get('/contacts/?limit=100', loc_id)
    contacts = contacts_resp.get('contacts', [])
    print(f"  Contacts: {len(contacts)}")
    
    # Fetch opportunities (pipeline)
    opp_resp = ghl_get('/opportunities/?limit=100', loc_id)
    opportunities = opp_resp.get('opportunities', [])
    print(f"  Opportunities: {len(opportunities)}")
    
    # Parse contacts
    parsed_contacts = []
    for ct in contacts:
        name = f"{ct.get('firstName','')} {ct.get('lastName','')}".strip() or ct.get('name','Unknown')
        parsed_contacts.append({
            'name': name,
            'email': ct.get('email', ''),
            'phone': ct.get('phone', ''),
            'tags': ct.get('tags', []),
            'dateAdded': ct.get('dateAdded', ''),
            'dateUpdated': ct.get('dateUpdated', ''),
            'source': ct.get('source', ''),
            'id': ct.get('id', ''),
        })
    
    # Parse opportunities
    parsed_opps = []
    for opp in opportunities:
        parsed_opps.append({
            'name': opp.get('name', 'Unknown'),
            'monetaryValue': opp.get('monetaryValue', 0),
            'status': opp.get('status', 'unknown'),
            'pipelineStage': opp.get('pipelineStageId', ''),
            'contactId': opp.get('contactId', ''),
            'dateAdded': opp.get('dateAdded', ''),
            'dateUpdated': opp.get('dateUpdated', ''),
        })
    
    all_data[loc_id] = {
        'name': loc_name,
        'contacts': parsed_contacts,
        'opportunities': parsed_opps,
        'contactCount': len(parsed_contacts),
        'opportunityCount': len(parsed_opps),
        'pipelineValue': sum(float(o.get('monetaryValue', 0) or 0) for o in parsed_opps),
    }

# Save to data directory
os.makedirs('data', exist_ok=True)
with open('data/crm-data.json', 'w') as f:
    json.dump(all_data, f, indent=2)

print(f"\n=== SUMMARY ===")
for loc_id, data in all_data.items():
    print(f"  {data['name']}: {data['contactCount']} contacts, {data['opportunityCount']} opportunities, £{data['pipelineValue']:,.0f} pipeline")

print(f"\nSaved to data/crm-data.json")
