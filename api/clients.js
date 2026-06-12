// /api/clients.js — Returns client list (static for now, GHL agency search needs OAuth scope)
// The client list rarely changes, so static is fine. CRM data is live.

const STATIC_CLIENTS = {
  'Z9UtrrCvJc8ObhTIILLF': { name: 'Airway Clinic', sub: 'Sleep Clinic · Stockholm, SE' },
  'pvH5KtdWPkbvSWR49akA': { name: 'Altri Medical', sub: 'Medical Devices · Altrincham, UK' },
  '09IvUpMsLtP5pFni6mNK': { name: 'Cloud Hak AI', sub: 'AI Agency · Hove, UK' },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ clients: STATIC_CLIENTS });
}
