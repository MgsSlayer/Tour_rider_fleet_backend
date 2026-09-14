const express = require('express');
const router = express.Router();
const { login, me } = require('../../controllers/auth.controller.js');
const { loginLimiter } = require('../../middleware/rate.limiter.js');
const { verifyJWT } = require('../../middleware/auth.middleware.js');

router.post('/login', loginLimiter, login);
router.get('/me', verifyJWT, me);

module.exports = router;
