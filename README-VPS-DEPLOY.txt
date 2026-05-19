DigiLeads VPS Worker Deploy Package
===================================

Use this package only for the NEW DigiLeads extractor.
Old extractor running on PORT=3000 should NOT be touched.

Configured for:
- Worker domain: extractors.clickconnectmedia.cloud
- Main panel: https://digileads.clickconnectmedia.cloud/api-worker.php
- Node port: 3002
- PM2 process name: digileads-extractor

1) Upload this folder to VPS:
   /var/www/LeadOS-digileads-vps-worker

2) Install dependencies:
   cd /var/www/LeadOS-digileads-vps-worker
   chmod +x install.sh start.sh
   ./install.sh

3) Check .env:
   nano .env

Required values already set:
   PORT=3002
   LEADOS_API_KEY=Digileads_Extractor_2026_Secure_Key@98765
   APP_API_URL=https://digileads.clickconnectmedia.cloud/api-worker.php
   HEADLESS=true

IMPORTANT:
- LEADOS_API_KEY must be exactly same as scraper_api_key in PHP config.php.
- Main website config.php should use:
  'scraper_api_url' => 'https://extractors.clickconnectmedia.cloud/run-job'

4) Start with PM2 without touching old extractor:
   pm2 start ecosystem.config.js
   pm2 save

5) Test local worker:
   curl http://127.0.0.1:3002/health

6) Nginx reverse proxy:
   Copy nginx-sample.conf to:
   /etc/nginx/sites-available/extractors.clickconnectmedia.cloud

   Then:
   sudo ln -s /etc/nginx/sites-available/extractors.clickconnectmedia.cloud /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx

7) SSL:
   sudo certbot --nginx -d extractors.clickconnectmedia.cloud

8) Public test:
   https://extractors.clickconnectmedia.cloud/health

Troubleshooting:
- If port busy: sudo lsof -i :3002
- Old extractor remains on 3000.
- New DigiLeads extractor must run on 3002.
- If admin remains queued, check Nginx proxy and worker health URL.
- If 401 Unauthorized, API key mismatch between .env and PHP config.php.
