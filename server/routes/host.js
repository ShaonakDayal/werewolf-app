const express = require('express');
const QRCode = require('qrcode');
const roomLogic = require('../roomLogic');
const sse = require('../sse');

const router = express.Router();

function wrap(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      if (err instanceof roomLogic.ApiError) {
        res.status(err.status).json({ error: err.code, message: err.message });
      } else {
        // eslint-disable-next-line no-console
        console.error(err);
        res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
      }
    });
  };
}

function urls(req, room) {
  const base = `${req.protocol}://${req.get('host')}`;
  return {
    joinUrl: `${base}/player/?room=${room.code}`,
    dashboardUrl: `${base}/host/?room=${room.code}&secret=${room.hostSecret}`,
  };
}

// ---- Shared role library ----

router.get('/roles', wrap(async (req, res) => {
  res.json(await roomLogic.getRoleLibrary());
}));

router.post('/roles', wrap(async (req, res) => {
  res.status(201).json(await roomLogic.addRole(req.body));
}));

router.put('/roles/:id', wrap(async (req, res) => {
  res.json(await roomLogic.updateRole(req.params.id, req.body));
}));

router.delete('/roles/:id', wrap(async (req, res) => {
  await roomLogic.deleteRole(req.params.id);
  res.status(204).end();
}));

// ---- Rooms ----

router.post('/rooms', wrap(async (req, res) => {
  const room = await roomLogic.createRoom(req.body);
  const { joinUrl, dashboardUrl } = urls(req, room);
  const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, scale: 6 });
  res.status(201).json({ ...roomLogic.hostView(room), joinUrl, dashboardUrl, qrDataUrl });
}));

router.get('/rooms/:code', wrap(async (req, res) => {
  const room = await roomLogic.loadRoom(req.params.code);
  roomLogic.verifyHostSecret(room, req.query.hostSecret);
  const { joinUrl, dashboardUrl } = urls(req, room);
  const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, scale: 6 });
  res.json({ ...roomLogic.hostView(room), joinUrl, dashboardUrl, qrDataUrl });
}));

router.get('/rooms/:code/stream', wrap(async (req, res) => {
  const room = await roomLogic.loadRoom(req.params.code);
  roomLogic.verifyHostSecret(room, req.query.hostSecret);
  sse.sseHeaders(res);
  sse.addHostClient(req.params.code, res);
  sse.send(res, 'state', roomLogic.hostView(room));
}));

router.post('/rooms/:code/start', wrap(async (req, res) => {
  const room = await roomLogic.startGame(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json(roomLogic.hostView(room));
}));

router.post('/rooms/:code/night/begin', wrap(async (req, res) => {
  const room = await roomLogic.beginNight(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json(roomLogic.hostView(room));
}));

router.post('/rooms/:code/night/resolve', wrap(async (req, res) => {
  const result = await roomLogic.resolveNight(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json({ ...roomLogic.hostView(result.room), needsTieBreak: result.needsTieBreak, ties: result.ties || [] });
}));

router.post('/rooms/:code/night/break-tie', wrap(async (req, res) => {
  const room = await roomLogic.breakTie(req.params.code, { ...req.body, pollKind: 'night' });
  await sse.broadcast(req.params.code);
  res.json(roomLogic.hostView(room));
}));

router.post('/rooms/:code/vote/start', wrap(async (req, res) => {
  const room = await roomLogic.startVote(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json(roomLogic.hostView(room));
}));

router.post('/rooms/:code/vote/resolve', wrap(async (req, res) => {
  const result = await roomLogic.resolveVote(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json({
    ...roomLogic.hostView(result.room),
    needsTieBreak: result.needsTieBreak,
    tiedIds: result.tiedIds || [],
  });
}));

router.post('/rooms/:code/vote/break-tie', wrap(async (req, res) => {
  const room = await roomLogic.breakTie(req.params.code, { ...req.body, pollKind: 'vote' });
  await sse.broadcast(req.params.code);
  res.json(roomLogic.hostView(room));
}));

router.post('/rooms/:code/override', wrap(async (req, res) => {
  const room = await roomLogic.overridePlayerStatus(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json(roomLogic.hostView(room));
}));

router.post('/rooms/:code/end', wrap(async (req, res) => {
  const room = await roomLogic.endGame(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json(roomLogic.hostView(room));
}));

module.exports = router;
