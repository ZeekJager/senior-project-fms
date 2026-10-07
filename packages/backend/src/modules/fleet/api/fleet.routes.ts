import { Router } from 'express';

export const fleetRouter = Router();

// Smoke route proving the audited mutation path end to end (FMS-03).
// Remove once the depot API (FMS-20) exists.
fleetRouter.post('/test-audit', async (req, res) => {
  try {
    const inserted = await req.dbMutate('fleet.depots', 'INSERT', null, {
      name: 'Test Depot ' + Date.now(),
      location: 'Addis Ababa',
    });
    const deleted = await req.dbMutate('fleet.depots', 'DELETE', inserted.id as string);

    res.json({
      message: 'FMS-03 Audit test completed!',
      correlationId: req.correlationId,
      inserted,
      deleted,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
