const mongoose = require('mongoose');

const dbconnect = async () => {
  if (!process.env.DB_CONNECT_STRING) {
    throw new Error('DB_CONNECT_STRING is not set');
  }
  await mongoose.connect(process.env.DB_CONNECT_STRING);
  console.log('DB connected');
};

module.exports = dbconnect;
