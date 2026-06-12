// /api/crm.js — Serverless function that fetches live CRM data from GHL
// Token is stored as env var, NEVER exposed to the browser

const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// Location-specific tokens (stored as env vars in Vercel)
function getLocToken(locId) {
  const tokens = {
    'Z9UtrrCvJc8ObhTIILLF': process.env.GHL_AIRWAY_TOKEN,
    'pvH5KtdWPkbvSWR49akA': process.env.GHL_ALTRI_TOKEN,
    '09IvUpMsLtP5pFni6mNK': process.env.GHL_CLOUDHAK_TOKEN,
  };
  return tokens[locId] || process.env.GHL_AGENCY_TOKEN;
}

async function ghlGet(path, locId, startAfter, startAfterId) {
  const token = getLocToken(locId);
  const sep = path.includes('?') ? '&' : '?';
  let url = `${GHL_BASE}${path}${sep}locationId=${locId}`;
  if (startAfter) url += `&startAfter=${startAfter}`;
  if (startAfterId) url += `&startAfterId=${startAfterId}`;
  
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': VERSION,
    },
  });
  
  if (!resp.ok) {
    throw new Error(`GHL API ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

// Paginate through ALL contacts (GHL caps at 100/page, uses startAfter/startAfterId)
async function ghlGetAllContacts(locId) {
  let allContacts = [];
  let startAfter = null;
  let startAfterId = null;
  let pages = 0;
  let total = 0;
  
  do {
    const data = await ghlGet('/contacts/?limit=100', locId, startAfter, startAfterId);
    allContacts = allContacts.concat(data.contacts || []);
    total = data.meta?.total || allContacts.length;
    startAfter = data.meta?.startAfter || null;
    startAfterId = data.meta?.startAfterId || null;
    pages++;
    // Stop if no next page
    if (!data.meta?.nextPageUrl) break;
  } while (startAfterId && pages < 50); // safety cap at 5000 contacts
  
  return { contacts: allContacts, total };
}

export default async function handler(req, res) {
  try {
    const { locId } = req.query;
    
    if (!locId) {
      return res.status(400).json({ error: 'locId required' });
    }

    // Fetch all contacts (paginated) + opportunities in parallel
    const [allContactsResp, oppResp] = await Promise.allSettled([
      ghlGetAllContacts(locId),
      ghlGet('/opportunities/?limit=100', locId),
    ]);

    const rawContacts = allContactsResp.status === 'fulfilled' ? allContactsResp.value.contacts : [];
    const totalCount = allContactsResp.status === 'fulfilled' ? allContactsResp.value.total : 0;
    const oppData = oppResp.status === 'fulfilled' ? oppResp.value : { opportunities: [] };

    const contacts = rawContacts.map(ct => ({
      name: `${ct.firstName || ''} ${ct.lastName || ''}`.trim() || ct.name || 'Unknown',
      email: ct.email || '',
      phone: ct.phone || '',
      tags: ct.tags || [],
      dateAdded: ct.dateAdded || '',
      dateUpdated: ct.dateUpdated || '',
      source: ct.source || '',
    }));

    const opportunities = (oppData.opportunities || []).map(opp => ({
      name: opp.name || 'Unknown',
      monetaryValue: opp.monetaryValue || 0,
      status: opp.status || 'unknown',
      dateAdded: opp.dateAdded || '',
    }));

    const pipelineValue = opportunities.reduce((sum, o) => sum + (parseFloat(o.monetaryValue) || 0), 0);

    // Calculate new this month
    const now = new Date();
    const newThisMonth = contacts.filter(ct => {
      if (!ct.dateAdded) return false;
      const d = new Date(ct.dateAdded);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;

    // Group by source
    const sources = {};
    contacts.forEach(ct => {
      const src = ct.source || 'Direct';
      sources[src] = (sources[src] || 0) + 1;
    });
    const topSources = Object.entries(sources)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count, pct: Math.round(count / contacts.length * 100) }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    
    return res.status(200).json({
      contacts,
      opportunities,
      contactCount: totalCount,
      opportunityCount: opportunities.length,
      pipelineValue,
      newThisMonth,
      topSources,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err) {
    console.error('CRM API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
