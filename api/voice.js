// /api/voice.js — Dograh voice AI integration for Command Center
// Fetches live agent data from Dograh OSS instance

const DOGRAH_URL = process.env.DOGRAH_API_URL || 'http://localhost:8000';
const DOGRAH_EMAIL = 'nima@cloud-hak.com';
const DOGRAH_PASS = process.env.DOGRAH_PASSWORD || 'CloudHak2026!';

async function dograhLogin() {
  const resp = await fetch(`${DOGRAH_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DOGRAH_EMAIL, password: DOGRAH_PASS }),
  });
  if (!resp.ok) throw new Error(`Dograh login failed: ${resp.status}`);
  const data = await resp.json();
  return data.token;
}

async function getWorkflows(token) {
  const resp = await fetch(`${DOGRAH_URL}/api/v1/workflow/summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Failed to fetch workflows: ${resp.status}`);
  return resp.json();
}

async function getWorkflowRuns(token, workflowId) {
  const resp = await fetch(`${DOGRAH_URL}/api/v1/workflow/${workflowId}/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return { runs: [] };
  return resp.json();
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = await dograhLogin();
    const workflows = await getWorkflows(token);

    // For each workflow, get runs
    const enriched = await Promise.all(
      workflows.map(async (wf) => {
        try {
          const runsData = await getWorkflowRuns(token, wf.id);
          const runs = runsData.runs || [];

          const totalRuns = runs.length;
          const calls = runs.filter(r => r.mode === 'smallwebrtc' || r.mode === 'telephony');
          const chats = runs.filter(r => r.mode === 'textchat');
          const totalSeconds = runs.reduce((sum, r) => {
            const ci = r.cost_info || {};
            return sum + (ci.call_duration_seconds || 0);
          }, 0);

          // Get last run date
          const lastRun = runs.length > 0
            ? runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
            : null;

          return {
            id: wf.id,
            name: wf.name,
            status: wf.status || 'active',
            stats: {
              totalSessions: totalRuns,
              voiceCalls: calls.length,
              textChats: chats.length,
              totalSeconds,
              lastSession: lastRun ? lastRun.created_at : null,
            },
            recentSessions: runs
              .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
              .slice(0, 10)
              .map(r => ({
                id: r.id,
                name: r.name,
                mode: r.mode,
                duration: (r.cost_info || {}).call_duration_seconds || 0,
                created: r.created_at,
                completed: r.is_completed,
              })),
          };
        } catch (e) {
          return {
            id: wf.id,
            name: wf.name,
            status: 'error',
            stats: { totalSessions: 0, voiceCalls: 0, textChats: 0, totalSeconds: 0, lastSession: null },
            recentSessions: [],
          };
        }
      })
    );

    // Aggregate stats
    const totalAgents = enriched.length;
    const activeAgents = enriched.filter(a => a.status === 'active').length;
    const totalSessions = enriched.reduce((s, a) => s + a.stats.totalSessions, 0);
    const totalCalls = enriched.reduce((s, a) => s + a.stats.voiceCalls, 0);
    const totalSeconds = enriched.reduce((s, a) => s + a.stats.totalSeconds, 0);

    res.status(200).json({
      status: 'live',
      agents: enriched,
      summary: {
        totalAgents,
        activeAgents,
        totalSessions,
        totalCalls,
        totalChats: totalSessions - totalCalls,
        totalMinutes: Math.round(totalSeconds / 60 * 10) / 10,
      },
    });
  } catch (error) {
    res.status(200).json({
      status: 'offline',
      error: error.message,
      agents: [],
      summary: { totalAgents: 0, activeAgents: 0, totalSessions: 0, totalCalls: 0, totalChats: 0, totalMinutes: 0 },
    });
  }
};
