import { db } from '../db.js';
import { writeOutboxEvent } from '../outbox.js';

export async function createProduct(req, res) {
  const product = await db.transaction(async (tx) => {
    const created = await tx.products.insert(req.body);
    await writeOutboxEvent(tx, 'product-created', created);
    return created;
  });

  res.status(201).json(product);
}

export async function updateProduct(req, res) {
  const product = await db.transaction(async (tx) => {
    const updated = await tx.products.update(req.params.id, req.body);
    await writeOutboxEvent(tx, 'product-updated', updated);
    return updated;
  });

  res.json(product);
}

export async function getProduct(req, res) {
  res.json(await db.products.find(req.params.id));
}
