const jwt = require('jsonwebtoken');
const User = require('../models/user.model.js');
const v = require('../helpers/validate.js');

const login = async (req, res) => {
  try {
    const email = v.email(req.body?.email);
    const password = v.password(req.body?.password);

    const user = await User.findOne({ email });
    // same response either way so the endpoint can't be used to enumerate accounts
    if (!user || !(await user.verifyPassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    return res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    return v.handle(res, err, 'Login failed');
  }
};

const me = (req, res) => res.json({ user: req.user });

module.exports = { login, me };
