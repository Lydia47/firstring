// REST API for AI agents. Same handlers, same enum validation, same agency lookup as the voice agent.
import express from 'express';
import { findComplaintType, createServiceRequest, lookupRequestStatus, detectEmergency, logEmergency, EMERGENCY_MESSAGE } from './tools.mjs';

export function requireToken(req, res, next) {
  const want = process.env.FIRSTRING_API_TOKEN;
  if (!want) return res.status(503).json({ error: 'API disabled: FIRSTRING_API_TOKEN is not set on the server.' });
  if (req.get('authorization') !== `Bearer ${want}`) return res.status(401).json({ error: 'Missing or wrong bearer token.' });
  next();
}

export const apiRouter = express.Router();
apiRouter.use(requireToken);

apiRouter.get('/complaint-types', (req, res) => {
  const out = findComplaintType({ query: String(req.query.q || '') });
  res.status(out.error ? 400 : 200).json(out);
});

apiRouter.post('/requests', (req, res) => {
  const body = req.body || {};
  const hit = detectEmergency(`${body.details || ''} ${body.descriptor || ''}`);
  if (hit) {
    logEmergency({ channel: 'api', keyword: hit, where: 'POST /api/v1/requests' });
    return res.status(422).json({ error: EMERGENCY_MESSAGE, emergency: true });
  }
  const out = createServiceRequest(body, { channel: 'api', source: body.source === 'eval' ? 'eval' : 'demo' });
  res.status(out.error ? 422 : 201).json(out);
});

apiRouter.get('/requests/:id', (req, res) => {
  const out = lookupRequestStatus({ request_id: req.params.id });
  res.status(out.error ? 404 : 200).json(out);
});
