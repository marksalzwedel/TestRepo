export default function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      runtime: 'node',
      version: 'v1',
      now: new Date().toISOString(),
    });
  }
  return res.status(405).send('Method Not Allowed');
}
