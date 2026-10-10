# VPS Deployment Guide

Deploy OSW Studio on a VPS with full security hardening. Tested on Hetzner Cloud, but applies to any Ubuntu/Debian VPS.

---

## Pre-Creation (Hetzner Console)

> Skip this section if using a different VPS provider. The server setup steps below work on any Ubuntu 22.04+ server.

### 1. Add SSH Key

Security → SSH Keys → Add SSH Key

If you don't have one locally, generate it first:

```bash
ssh-keygen -t ed25519 -C "osws-server"
cat ~/.ssh/id_ed25519.pub
```

Paste the public key into Hetzner.

### 2. Create Cloud Firewall

Firewalls → Create Firewall

**Inbound rules (TCP only):**

| Port | Protocol | Source |
|------|----------|--------|
| 22   | TCP      | Any    |
| 80   | TCP      | Any    |
| 443  | TCP      | Any    |

Do NOT add port 3000 or any other app ports.

### 3. Create Server

- Select your SSH key
- Attach the firewall
- Smallest instance (CX11/CX21) is fine for testing

---

## Server Setup

SSH into the server:

```bash
ssh root@<your-ip>
```

### Update System

```bash
apt update && apt upgrade -y
```

### Create Non-Root User

```bash
adduser osws --disabled-password --gecos ""
mkdir -p /home/osws/.ssh
cp ~/.ssh/authorized_keys /home/osws/.ssh/
chown -R osws:osws /home/osws/.ssh
chmod 700 /home/osws/.ssh
chmod 600 /home/osws/.ssh/authorized_keys
```

### Harden SSH

```bash
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
```

### Install fail2ban

```bash
apt install fail2ban -y
systemctl enable fail2ban --now
```

### Add Swap (Prevents OOM on Small Instances)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Install & Configure Nginx

```bash
apt install nginx -y

cat > /etc/nginx/sites-available/osws << 'EOF'
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

ln -s /etc/nginx/sites-available/osws /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

---

## App Deployment

### Switch to osws User

```bash
su - osws
```

### Install Node.js

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
```

### Clone Repository

```bash
git clone https://github.com/o-stahl/osw-studio.git
cd osw-studio
```

### Create Environment File

```bash
SESSION_SECRET=$(openssl rand -base64 32)
ANALYTICS_SECRET=$(openssl rand -base64 32)
SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)

cat > .env << EOF
NEXT_PUBLIC_SERVER_MODE=true
SESSION_SECRET=$SESSION_SECRET
SECURE_COOKIES=false
ANALYTICS_SECRET=$ANALYTICS_SECRET
SECRETS_ENCRYPTION_KEY=$SECRETS_ENCRYPTION_KEY
EOF
```

> **Note:** `SECURE_COOKIES=false` is required when running HTTP without SSL. Remove this line after adding HTTPS.
>
> To let an outside agent (Claude Code, Cursor, and others that speak MCP) work on this instance, add `MCP_ENABLED=true` to `.env` and restart. See [MCP Server](?doc=mcp-server).
>
> No `ADMIN_PASSWORD` needed. On first visit to `/admin`, you'll create the admin account interactively.

### Build & Start

```bash
npm install
npm run build
npm install -g pm2
pm2 start npm --name "osws" -- start
pm2 save
```

### Enable PM2 on Boot

Exit back to root (`exit`) and run:

```bash
env PATH=$PATH:/home/osws/.nvm/versions/node/v20.18.1/bin pm2 startup systemd -u osws --hp /home/osws
```

> **Note:** Adjust the Node version path if you installed a different version.

---

## Access

- **Studio:** `http://<your-ip>/`
- **Admin:** `http://<your-ip>/admin`

---

## Updating OSW Studio

```bash
su - osws
cd ~/osw-studio
git pull
npm install
npm run build
pm2 restart osws
```

> **Important:** Any changes to `NEXT_PUBLIC_*` environment variables require a rebuild (`npm run build`) — these are baked in at compile time.

---

## Adding HTTPS (Recommended)

Once you have a domain pointing to your server:

As root:

```bash
apt install certbot python3-certbot-nginx -y
certbot --nginx -d your-domain.com
```

Then update the environment and rebuild:

```bash
su - osws
cd ~/osw-studio

# Edit .env to remove SECURE_COOKIES=false
nano .env

npm run build
pm2 restart osws
```

### Serving published sites from their own address

To keep published sites off the studio's address, add a second DNS name for them, give it a certificate, set `SITES_ORIGIN` and `NEXT_PUBLIC_APP_URL`, then rebuild and restart. See [Setting up a sites address](?doc=server-mode#setting-up-a-sites-address). Without it, sites run on the studio's address and the Deployments view shows a warning.

---

## Security Checklist

- ✅ Never expose port 3000 directly — always use nginx as reverse proxy
- ✅ App runs as non-root user `osws`
- ✅ SSH is key-only, no password authentication
- ✅ Cloud firewall blocks all ports except 22, 80, 443
- ✅ fail2ban protects against brute force attempts
- ✅ Swap prevents out-of-memory crashes on small instances
- ⬜ Serve published sites from a separate address (`SITES_ORIGIN` or `STATIC_PROXY`); the steps above do not set this up

### Configuring a mail server

Review-mode digests go out over plain SMTP, so anything that speaks it works: Mailhog while you are
developing, or a hosted relay in production. There is no vendor SDK and no OAuth flow.

Set it once as an instance admin, or at deploy time with `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM`. A value stored through the UI wins over the
environment, so an operator can override a provisioned config and clear the override to fall back.

A worked example, verified end to end against AgentMail:

| Field | Value |
|---|---|
| Host | `smtp.agentmail.to` |
| Port | `587` |
| Encryption | STARTTLS (`465` for implicit TLS also works) |
| Username | your inbox address, e.g. `you@agentmail.to` |
| Password | your AgentMail API key |
| From | the **same** inbox address |

The last row is a provider rule worth knowing before you debug it: AgentMail requires the From
address to match the inbox that authenticated. Some relays are stricter than others about this, and
the failure is a rejection at send time rather than a configuration error, so use **Send test email**
after any change — it reports the server's own message rather than a reworded one.

Mail is only written when a live server is available and sending is on. If a tier is off or no
server sits behind it, nothing is queued. Turning it back on starts from that moment, so a quiet
stretch does not arrive as one dump. Anything already queued for a tier is dropped when its switch
goes off.

This also shapes what a workspace can do. A workspace using the instance's mail server may override
the *display name* but not the address, which keeps SPF and DKIM aligned and is the reason those are
two separate settings. A workspace that needs its own From address has to bring its own relay, where
its domain is already authorised.

### SMTP passwords are stored in plaintext

SMTP passwords — both the instance's and any a workspace sets for its own relay — are stored
unencrypted in `data/system.sqlite`. They have to be usable as passwords when mail is sent, so
encrypting them would only move the problem to a key held on the same disk.

That makes the database file itself the thing to protect:

- Keep `data/` readable only by the `osws` user (it is by default; a restore from backup can widen it)
- Treat any backup of `data/system.sqlite` as carrying live mail credentials — encrypt it before it
  leaves the machine
- If the mail account allows it, use a relay-specific credential rather than a full mailbox password,
  so a leak costs you a sending key and not an inbox
- Consider full-disk encryption on the volume if the instance sends on behalf of other people

---

## Next Steps

- **[Server Mode](?doc=server-mode)** - Full Server Mode documentation
- **[Deployment Publishing](?doc=site-publishing)** - Publish deployments with analytics and SEO
- **[Backend](?doc=backend-features)** - Database, edge functions, secrets
