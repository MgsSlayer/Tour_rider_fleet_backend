const express = require('express');
const router = express.Router();
const { listBases, createBase, updateBase, deleteBase } = require('../../controllers/bases.controller.js');
const { verifyJWT, checkRole } = require('../../middleware/auth.middleware.js');

const adminOnly = [verifyJWT, checkRole('admin')];

router.get('/', ...adminOnly, listBases);
router.post('/', ...adminOnly, createBase);
router.patch('/:id', ...adminOnly, updateBase);
router.delete('/:id', ...adminOnly, deleteBase);

module.exports = router;
