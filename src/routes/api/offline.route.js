const express = require('express');
const router = express.Router();
const { chooseOffline } = require('../../controllers/offline.controller.js');

router.post('/choose', chooseOffline);

module.exports = router;
