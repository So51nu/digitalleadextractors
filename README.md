# LeadOS Fast Google Worker

This worker uses Node.js + Playwright browser automation to open Google Maps directly, process queued extraction jobs, save cleaned leads into MySQL, and update job progress. It does not require any paid third-party API.

## Setup

```bash
cd scraper-node
npm install
npm run install-browsers
cp .env.example .env
nano .env
npm start
```

Set the same MySQL details used in `config.php`. Then open Superadmin > Automation Engine and save your worker URL:

```text
http://YOUR_SERVER_IP:5050/run-job
```

For production, run behind HTTPS/Nginx and keep `LEADOS_API_KEY` private.

Use the worker only in a way that complies with applicable website terms, laws, and rate limits.
