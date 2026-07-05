'use strict';

const crypto = require('crypto');

function uid(prefix) {
  return String(prefix || 'id') + '-' + crypto.randomBytes(8).toString('hex');
}

module.exports = {
  uid,
};
