export async function writeOutboxEvent(tx, type, payload) {
  await tx.outbox.insert({ type, payload: JSON.stringify(payload), publishedAt: null });
}
