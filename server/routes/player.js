const express = require('express');
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

router.get('/rooms/:code', wrap(async (req, res) => {
  const room = await roomLogic.loadRoom(req.params.code);
  res.json(roomLogic.lobbyView(room));
}));

router.post('/rooms/:code/join', wrap(async (req, res) => {
  const { room, player } = await roomLogic.joinRoom(req.params.code, req.body.name);
  await sse.broadcast(req.params.code);
  res.status(201).json({ playerId: player.id, token: player.token, ...roomLogic.playerView(room, player.id) });
}));

router.get('/rooms/:code/me', wrap(async (req, res) => {
  const room = await roomLogic.loadRoom(req.params.code);
  const player = roomLogic.verifyPlayerToken(room, req.query.playerId, req.query.token);
  res.json(roomLogic.playerView(room, player.id));
}));

router.get('/rooms/:code/stream', wrap(async (req, res) => {
  const room = await roomLogic.loadRoom(req.params.code);
  const player = roomLogic.verifyPlayerToken(room, req.query.playerId, req.query.token);
  sse.sseHeaders(res);
  sse.addPlayerClient(req.params.code, player.id, res);
  sse.send(res, 'state', roomLogic.playerView(room, player.id));
}));

router.post('/rooms/:code/night-action', wrap(async (req, res) => {
  const room = await roomLogic.submitNightAction(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json(roomLogic.playerView(room, req.body.playerId));
}));

router.post('/rooms/:code/vote', wrap(async (req, res) => {
  const room = await roomLogic.submitVote(req.params.code, req.body);
  await sse.broadcast(req.params.code);
  res.json(roomLogic.playerView(room, req.body.playerId));
}));

module.exports = router;
