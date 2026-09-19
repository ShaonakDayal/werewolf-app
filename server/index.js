require('dotenv').config();
const path = require('path');
const express = require('express');
const hostRoutes = require('./routes/host');
const playerRoutes = require('./routes/player');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.use('/api/host', hostRoutes);
app.use('/api/player', playerRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  const qs = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
  res.redirect(`/player/${qs}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Werewolf app listening on port ${PORT}`);
});
