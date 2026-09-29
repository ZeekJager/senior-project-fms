const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'ok', service: 'fms-backend', timestamp: new Date() });
});

app.listen(PORT, () => {
    console.log(`[fms-backend] running on port ${PORT}`);
});
