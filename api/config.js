// /api/config.js — Source of truth: clients.json in the GitHub repo
// GET  → reads clients.json from repo
// POST → two actions:
//   { action: 'toggle', locId, serviceId, active } — toggle service on/off
//   { action: 'price',  locId, serviceId, price, discount } — set custom price/discount %

const GH_OWNER = 'nemoaiassistant-hue';
const GH_REPO = 'cloud-hak-command-center';
const GH_PATH = 'data/clients.json';
const GH_BRANCH = 'main';

async function getFromGitHub(token) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'cloud-hak-command-center',
    },
  });
  if (!resp.ok) throw new Error(`GitHub ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { json: JSON.parse(content), sha: data.sha };
}

async function saveToGitHub(token, content, sha) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'cloud-hak-command-center',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'Update client config via Command Center',
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      sha: sha,
      branch: GH_BRANCH,
    }),
  });
  if (!resp.ok) throw new Error(`GitHub ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// Calculate effective price for a service (custom > discount > default)
function getEffectivePrice(serviceId, defaultPrice, client) {
  const cp = client.customPricing?.[serviceId];
  if (cp) {
    if (cp.price != null) return cp.price;
    if (cp.discount != null) return Math.round(defaultPrice * (1 - cp.discount / 100));
  }
  return defaultPrice;
}

// Recalculate client MRR from all active services with custom pricing
function recalcMrr(client, services) {
  const defaultPrices = {};
  services.forEach(s => { defaultPrices[s.id] = s.price; });
  return Object.entries(client.services)
    .filter(([_, on]) => on)
    .reduce((sum, [id]) => sum + getEffectivePrice(id, defaultPrices[id] || 0, client), 0);
}

export default async function handler(req, res) {
  try {
    const token = process.env.GH_TOKEN;

    if (req.method === 'GET') {
      const { json } = await getFromGitHub(token);
      res.setHeader('Cache-Control', 'no-cache');
      return res.status(200).json(json);
    }

    if (req.method === 'POST') {
      const body = req.body;
      const action = body.action || 'toggle';
      const { json: data, sha } = await getFromGitHub(token);
      const client = data.clients.find(c => c.locId === body.locId);
      if (!client) return res.status(404).json({ error: 'Client not found' });

      if (!client.customPricing) client.customPricing = {};

      if (action === 'toggle') {
        const { serviceId, active } = body;
        if (!serviceId || typeof active !== 'boolean') {
          return res.status(400).json({ error: 'serviceId and active (boolean) required' });
        }
        client.services[serviceId] = active;
      }

      else if (action === 'price') {
        const { serviceId, price, discount } = body;
        if (!serviceId) return res.status(400).json({ error: 'serviceId required' });

        // price = null means clear custom price, discount = null means clear discount
        if (!client.customPricing[serviceId]) client.customPricing[serviceId] = {};
        client.customPricing[serviceId].price = price != null ? Number(price) : undefined;
        client.customPricing[serviceId].discount = discount != null ? Number(discount) : undefined;

        // Clean up — remove empty entries
        const cp = client.customPricing[serviceId];
        if (cp.price == null && cp.discount == null) {
          delete client.customPricing[serviceId];
        }
      }

      else {
        return res.status(400).json({ error: 'Unknown action: ' + action });
      }

      // Recalculate MRR
      client.mrr = recalcMrr(client, data.services);

      await saveToGitHub(token, data, sha);

      return res.status(200).json({
        success: true,
        client: client.name,
        mrr: client.mrr,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Config API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
