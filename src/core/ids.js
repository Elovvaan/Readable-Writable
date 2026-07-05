'use strict';

const crypto = require('crypto');

function uid(prefix) {
  return String(prefix) + '-' + crypto.randomBytes(4).toString('hex');
}

module.exports = {
  uid,
};
