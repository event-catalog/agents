export const handlers = {
  enrichProduct: async (job, db) => {
    await db.products.update(job.productId, { enrichedAt: new Date() });
  },
};
