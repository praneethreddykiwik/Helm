// R168: public uptime/health probe.
// Vercel serves dist/ (the static build) for the site, so public/server.js is
// never run in prod and its /api/health is unreachable. A root-level api/
// function is detected by Vercel independently of the custom build
// (framework:null, outputDirectory:dist) and of the rewrites, which never match
// /api/* (the vercel.json redirect at /:path((?!api/).*) explicitly carves it
// out). Intentionally trivial: no database, no env/secrets, no imports — it must
// answer 200 fast and never depend on anything that can be down.
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  res.status(200).json({ ok: true, service: 'helm', time: new Date().toISOString() });
};
