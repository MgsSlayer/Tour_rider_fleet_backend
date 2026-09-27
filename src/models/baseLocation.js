const mongoose = require('mongoose');

// Bases the fleet departs from. Repositioning is measured from whichever of
// these is the shortest drive to the pickup — so a Miami job measured from a
// Miami yard correctly attracts no surcharge.
const baseLocationSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true },
  address: { type: String, required: true, trim: true },
}, { timestamps: true });

module.exports = mongoose.model('BaseLocation', baseLocationSchema);
