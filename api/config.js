// /api/config.js — Source of truth: clients.json in the GitHub repo
// GET  → reads clients.json from repo (or local fallback)
// POST → updates a client's service toggle via GitHub commit

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

export default async function handler(req, res) {
  try {
    const token = process.env.GH_TOKEN;

    if (req.method === 'GET') {
      const { json } = await getFromGitHub(token);
      res.setHeader('Cache-Control', 'no-cache');
      return res.status(200).json(json);
    }

    if (req.method === 'POST') {
      const { locId, serviceId, active } = req.body;
      if (!locId || !serviceId || typeof active !== 'boolean') {
        return res.status(400).json({ error: 'locId, serviceId, and active (boolean) required' });
      }

      const { json: data, sha } = await getFromGitHub(token);
      const client = data.clients.find(c => c.locId === locId);
      if (!client) return res.status(404).json({ error: 'Client not found' });

      client.services[serviceId] = active;

      // Recalculate MRR
      const prices = {};
      data.services.forEach(s => { prices[s.id] = s.price; });
      client.mrr = Object.entries(client.services)
        .filter(([_, on]) => on)
        .reduce((sum, [id]) => sum + (prices[id] || 0), 0);

      await saveToGitHub(token, data, sha);

      return res.status(200).json({
        success: true,
        client: client.name,
        service: serviceId,
        active: active,
        newMrr: client.mrr,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Config API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
