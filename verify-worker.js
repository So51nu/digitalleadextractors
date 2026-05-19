// Local syntax/import smoke check. Run after npm install: node verify-worker.js
require('dotenv').config();
require('express');
require('cors');
require('playwright');
require('./scrapers/generic');
console.log('OK: LeadOS worker dependencies and modules loaded.');
console.log('PORT:', process.env.PORT || 3000);
console.log('APP_API_URL:', process.env.APP_API_URL || '(missing)');
console.log('HEADLESS:', process.env.HEADLESS || 'true');
