// config/env.js throws at import when these are missing, and many modules
// reach it through a model import. Unit tests never connect, so placeholders
// are enough; real values from the shell still win.
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/unit-test';
process.env.JWT_SECRET ??= 'unit-test-secret';
