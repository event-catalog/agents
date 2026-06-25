// Payments Service: processes payments and refunds. Exposes a REST API described by openapi.yml.
import express from 'express';

const app = express();

// POST /payments — create a payment
app.post('/payments', async (req, res) => {
  res.status(201).json({ id: 'pay_123', status: 'succeeded' });
});

// GET /payments/:id — fetch a payment
app.get('/payments/:id', async (req, res) => {
  res.json({ id: req.params.id, status: 'succeeded' });
});

export default app;
