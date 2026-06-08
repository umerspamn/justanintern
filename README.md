# CVForge — EC2 Deployment Guide

Firebase has been fully removed. The app runs entirely on localStorage in
the browser. No server-side code, no database, no API keys needed.

---

## Files in this package

```
cvforge-ec2/
├── index.html                  ← The entire app (HTML + CSS + JS)
├── setup.sh                    ← Downloads assets on the EC2 instance
├── cvforge.nginx.conf          ← nginx virtual host config
├── README.md                   ← This file
└── assets/
    ├── js/
    │   └── html2pdf.bundle.min.js    ← PDF export (setup.sh downloads this)
    ├── css/
    │   └── plus-jakarta-sans.css     ← Self-hosted font declarations
    └── fonts/
        └── PlusJakartaSans-*.woff2   ← Font files (setup.sh downloads these)
```

---

## Step-by-step deployment on Amazon Linux 2 / Ubuntu

### 1. Launch EC2 instance

- AMI: Ubuntu 22.04 LTS or Amazon Linux 2
- Instance type: t2.micro (free tier) or larger
- Security group inbound rules:
  - Port 22 (SSH) — your IP only
  - Port 80 (HTTP) — 0.0.0.0/0
  - Port 443 (HTTPS) — 0.0.0.0/0 (when SSL is added)

### 2. SSH into the instance

```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
# or for Amazon Linux:
ssh -i your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP
```

### 3. Install nginx

**Ubuntu:**
```bash
sudo apt update && sudo apt install -y nginx
sudo systemctl enable nginx && sudo systemctl start nginx
```

**Amazon Linux 2:**
```bash
sudo yum update -y && sudo amazon-linux-extras install nginx1
sudo systemctl enable nginx && sudo systemctl start nginx
```

### 4. Create the web root

```bash
sudo mkdir -p /var/www/cvforge
sudo chown -R $USER:$USER /var/www/cvforge
```

### 5. Upload files from your local machine

Run this from your **local terminal** (not the EC2 terminal):

```bash
# Replace YOUR_KEY and YOUR_EC2_IP
scp -i your-key.pem -r ./cvforge-ec2/* ubuntu@YOUR_EC2_IP:/var/www/cvforge/
```

Or use FileZilla / WinSCP if you prefer a GUI.

### 6. Run the setup script on EC2

```bash
cd /var/www/cvforge
bash setup.sh
```

This downloads:
- `html2pdf.bundle.min.js` — PDF export library
- `PlusJakartaSans-*.woff2` — 6 font weight files

Takes ~10 seconds. Shows ✓ for each file.

### 7. Configure nginx

```bash
# Edit the config: replace YOUR_DOMAIN_OR_IP with your EC2 public IP or domain
nano /var/www/cvforge/cvforge.nginx.conf

# Install it
sudo cp /var/www/cvforge/cvforge.nginx.conf /etc/nginx/sites-available/cvforge

# Ubuntu only (Amazon Linux uses /etc/nginx/conf.d/ — see note below)
sudo ln -s /etc/nginx/sites-available/cvforge /etc/nginx/sites-enabled/cvforge

# Remove default site if it conflicts
sudo rm -f /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

> **Amazon Linux note:** Copy to `/etc/nginx/conf.d/cvforge.conf` instead:
> ```bash
> sudo cp cvforge.nginx.conf /etc/nginx/conf.d/cvforge.conf
> ```

### 8. Test it

Open in your browser:
```
http://YOUR_EC2_PUBLIC_IP/
```

You should see the CVForge app. Build your CV, export PDF — all working.

---

## Optional: Add HTTPS with Let's Encrypt (strongly recommended)

```bash
# Ubuntu
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com

# Amazon Linux 2
sudo yum install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Certbot automatically edits your nginx config and sets up auto-renewal.

> You need a domain name pointing to your EC2 IP for certbot to work.
> If you only have an IP address, use HTTP or set up a free domain at
> freenom.com or get a subdomain from your DNS provider.

---

## How data is stored

| Before (Firebase)                     | Now (localStorage)                    |
|---------------------------------------|---------------------------------------|
| Firestore `cvs/{userId}` document     | `localStorage["cvforge_autosave"]`    |
| Firestore `public_profiles/{userId}`  | `localStorage["cvforge_autosave"]` (isPublic field) |
| Real-time cross-device sync           | Not available (single-browser only)   |
| Cloud backup                          | Use "Backup" button → downloads JSON  |

Data persists in the browser until the user clears their browser storage
or clicks "Clear All Data" in the Settings tab.

---

## Re-adding Firebase later

When you're ready to add Firebase back:

1. Restore `firebase-config.js` and `firebase-service.js` to the web root
2. Add these `<script>` tags back in `index.html` `<head>`:
   ```html
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
   <script src="firebase-config.js"></script>
   <script src="firebase-service.js"></script>
   ```
3. In `index.html` script section, restore:
   - `firebaseSave()` call inside `live()`
   - `buildFirestorePayload()` function
   - `calcYearsFromDates()` function
   - `window.setProfileVisibility()` call inside `onPublicToggle()`
   - `window.logPDFDownload()` call inside `exportPDF()`
   - Firestore restore in the `boot()` function
   - `window.startRealtimeSync()` call in `boot()`

All removed code is preserved as comments marked `// FIREBASE REMOVED:`
in `index.html` so nothing needs to be rewritten from scratch.

---

## Troubleshooting

**White screen / 404:**
- Check nginx error log: `sudo tail -f /var/log/nginx/cvforge.error.log`
- Verify `root` path in nginx config matches where files are uploaded

**PDF export not working:**
- Run `setup.sh` again — html2pdf.js may not have downloaded
- Check browser console for JS errors (F12)

**Font looks wrong:**
- The app falls back to `system-ui` sans-serif if woff2 files are missing
- Re-run `setup.sh` to download fonts

**ERR_CONNECTION_REFUSED:**
- Check nginx is running: `sudo systemctl status nginx`
- Check EC2 security group allows inbound port 80
