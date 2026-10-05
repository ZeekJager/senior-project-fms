const express = require('express');
const cors = require('cors');
const requestContext = require('./middleware/requestContext');
const auditLogMiddleware = require('./middleware/auditLog');

const app = express();
app.use(cors());
app.use(express.json());

// Inject correlation_id and dbMutate helper on every request
app.use(requestContext);
app.use(auditLogMiddleware);

const PORT = process.env.PORT || 3000;

app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'ok', service: 'fms-backend', timestamp: new Date() });
});

// Test route to prove FMS-03 works (we can delete this later when real routes exist)
app.post('/api/v1/test-audit', async (req, res) => {
    try {
        // 1. Insert a mock depot
        const inserted = await req.dbMutate('depots', 'INSERT', null, {
            name: 'Test Depot ' + Date.now(),
            location: 'Addis Ababa'
        });
        
        // 2. Soft-delete the mock depot immediately
        const deleted = await req.dbMutate('depots', 'DELETE', inserted.id);
        
        res.json({
            message: "FMS-03 Audit test completed!",
            correlationId: req.correlationId,
            inserted,
            deleted
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`[fms-backend] running on port ${PORT}`);
});
