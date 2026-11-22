<div align="center">

<img src="assets/nyamal-naath-banner.svg" alt="Nyamal AI and Naath Heritage secure integration" width="100%">

# Nyamal × Naath Heritage

### Secure Editorial Draft Bridge

**AI-assisted content delivery. Human-controlled publishing.**

[![PHP](https://img.shields.io/badge/PHP-8%2B-777BB4?logo=php&logoColor=white)](https://www.php.net/)
[![MySQL](https://img.shields.io/badge/MySQL-Compatible-4479A1?logo=mysql&logoColor=white)](#requirements)
[![HTTPS](https://img.shields.io/badge/HTTPS-Required-15803d)](#security)
[![REST API](https://img.shields.io/badge/API-REST-2563eb)](#api)
[![Draft Only](https://img.shields.io/badge/PUBLISHING-DRAFT_ONLY-d97706)](#editorial-safety)

*A secure bridge that sends Nyamal-created stories into a private Naath Heritage inbox for review.*

</div>

---

<table>
<tr>
<td align="center" width="25%"><strong>✍️ Source</strong><br>Nyamal AI</td>
<td align="center" width="25%"><strong>🌐 Destination</strong><br>Naath Heritage</td>
<td align="center" width="25%"><strong>🗄️ Storage</strong><br>Isolated MySQL inbox</td>
<td align="center" width="25%"><strong>🛡️ Publishing</strong><br>Human approval</td>
</tr>
</table>

> [!IMPORTANT]
> **Draft-only by design.** This connector does not publish to the public website. Every accepted submission is server-enforced as `pending_review`. Existing Naath Heritage news, history, user, and settings tables are not modified.

## ✨ How It Works

```mermaid
flowchart LR
    A["🤖 Nyamal AI<br/>Create content"] -->|"HTTPS · Bearer token"| B["🔐 Secure API<br/>Authenticate & validate"]
    B --> C[("🗄️ Isolated Inbox<br/>MySQL")]
    C --> D["📝 Pending Review"]
    D --> E["👤 Human Editor"]
    E -->|"Existing website workflow"| F["✅ Publish manually<br/>if approved"]
```

## 📦 What's Included

<table>
<tr>
<td width="50%">

**Connector & Database**
- `nyamal-api.php` — authenticated endpoint
- `create_inbox_table.sql` — isolated inbox table
- `nyamal-api-config.example.php` — safe config template
- `.htaccess` — optional Apache protection

</td>
<td width="50%">

**Documentation**
- `INSTALL.md` — deployment walkthrough
- `SECURITY.md` — security checklist
- `.gitignore` — excludes secret configuration

</td>
</tr>
</table>

## 🚀 Installation

<table>
<tr><td align="center"><strong>01</strong></td><td><strong>Back up</strong><br>Export a full Naath Heritage database backup from phpMyAdmin.</td></tr>
<tr><td align="center"><strong>02</strong></td><td><strong>Create inbox</strong><br>Run <code>create_inbox_table.sql</code> in the correct database. Only the new inbox table is created.</td></tr>
<tr><td align="center"><strong>03</strong></td><td><strong>Upload API</strong><br>Upload <code>nyamal-api.php</code> to your website API folder.</td></tr>
<tr><td align="center"><strong>04</strong></td><td><strong>Configure secrets</strong><br>Copy the example config to <code>nyamal-api-config.php</code> and add your database credentials and long random token.</td></tr>
<tr><td align="center"><strong>05</strong></td><td><strong>Connect Nyamal</strong><br>Add the Naath Heritage REST API integration with POST, Bearer token, and <code>force_draft: true</code>.</td></tr>
<tr><td align="center"><strong>06</strong></td><td><strong>Test submission</strong><br>Send a test draft and verify its status is <code>pending_review</code>.</td></tr>
</table>

➡️ **[Read the full installation guide](INSTALL.md)**

## 🔌 API

**Example endpoint** — change this URL if your hosting path differs:

```text
https://naath.site.je/api/nyamal-api.php
```

### Request

`POST` · `Content-Type: application/json`

```http
Authorization: Bearer YOUR_LONG_RANDOM_TOKEN
```

<details>
<summary><strong>Example JSON payload</strong></summary>

```json
{
  "destination": "naath_heritage",
  "title": "A test story",
  "content": "Draft body for editorial review.",
  "excerpt": "Optional summary",
  "category": "News",
  "author": "Nyamal AI",
  "source_url": "https://example.org/source",
  "image_url": "https://example.org/image.jpg",
  "force_draft": true
}
```

Only `title` and `content` are required. URL fields must be valid HTTPS URLs.

</details>

### Response · `201 Created`

```json
{
  "success": true,
  "message": "Draft received for editorial review.",
  "status": "pending_review",
  "id": 123
}
```

## 🛡️ Security

| Protection | Implementation |
|---|---|
| Transport | HTTPS required |
| Authentication | Bearer token |
| Methods | POST only |
| Payload | JSON validation + size limit |
| Database | PDO prepared statements |
| URLs | HTTPS validation |
| Publishing | Server forces `pending_review` |
| Data scope | Isolated inbox table only |

➡️ **[Read security details](SECURITY.md)**

## 🧭 Editorial Safety

- Nyamal can **submit** content drafts.
- Nyamal cannot **publish** content.
- API requests cannot override the review status.
- Existing public content is not modified.
- An editor must review and publish using the existing website workflow.

## ⚙️ Requirements

- PHP 8+ with PDO MySQL extension
- MySQL-compatible database
- HTTPS enabled
- Database account with appropriate limited privileges

## 📌 Deployment Note

This is a standalone connector. Displaying inbox items inside the Naath Heritage admin dashboard or integrating with its existing news publishing workflow requires a separate change based on the site's actual PHP code and database schema.

---

<div align="center">

### Built for responsible automation.

**Designed for editorial control · Protected by human review**

*Nyamal AI × Naath Heritage*

</div>
