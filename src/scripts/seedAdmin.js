// usage: node src/scripts/seedAdmin.js "Name" admin@example.com 'password'
require('dotenv').config();
const dbconnect = require('../config/dbconnect.js');
const User = require('../models/user.model.js');

(async () => {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error('usage: node src/scripts/seedAdmin.js "Name" email password');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('refusing: choose a password of at least 12 characters');
    process.exit(1);
  }

  await dbconnect();
  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    existing.name = name;
    existing.password = password;
    await existing.save();
    console.log(`updated admin ${email}`);
  } else {
    await User.create({ name, email, password, role: 'admin' });
    console.log(`created admin ${email}`);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
