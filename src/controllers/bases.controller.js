const BaseLocation = require('../models/baseLocation.js');
const v = require('../helpers/validate.js');

const DEFAULT_BASE = {
  label: 'New York base',
  address: '1090 E 34th St, New York, NY, United States',
};

/** First run has no bases — seed the original one so behaviour is unchanged. */
async function ensureSeeded() {
  if (await BaseLocation.estimatedDocumentCount() === 0) {
    await BaseLocation.create(DEFAULT_BASE);
  }
}

const listBases = async (req, res) => {
  try {
    await ensureSeeded();
    const bases = await BaseLocation.find().sort({ createdAt: 1 }).lean();
    return res.json({ bases });
  } catch (err) {
    console.error('listBases error:', err);
    return res.status(500).json({ error: 'Could not load base locations' });
  }
};

const createBase = async (req, res) => {
  try {
    const label = v.text(req.body?.label, 'Label', { max: v.LIMITS.label });
    const address = v.text(req.body?.address, 'Address', { max: v.LIMITS.address });
    if (await BaseLocation.countDocuments() >= 25) {
      return res.status(400).json({ error: 'That is as many bases as we support' });
    }
    const base = await BaseLocation.create({ label, address });
    return res.status(201).json({ base });
  } catch (err) {
    return v.handle(res, err, 'Could not save that base');
  }
};

const updateBase = async (req, res) => {
  try {
    const label = v.text(req.body?.label, 'Label', { max: v.LIMITS.label });
    const address = v.text(req.body?.address, 'Address', { max: v.LIMITS.address });
    const base = await BaseLocation.findByIdAndUpdate(
      req.params.id, { label, address }, { new: true }
    );
    if (!base) return res.status(404).json({ error: 'Base not found' });
    return res.json({ base });
  } catch (err) {
    return v.handle(res, err, 'Could not update that base');
  }
};

const deleteBase = async (req, res) => {
  try {
    const gone = await BaseLocation.findByIdAndDelete(req.params.id);
    if (!gone) return res.status(404).json({ error: 'Base not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('deleteBase error:', err);
    return res.status(500).json({ error: 'Could not remove that base' });
  }
};

module.exports = { listBases, createBase, updateBase, deleteBase, ensureSeeded, DEFAULT_BASE };
