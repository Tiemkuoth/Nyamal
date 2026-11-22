<div align="center">

# NYAMAL × NAATH HERITAGE

### Secure Editorial Draft Bridge

**AI-assisted content delivery. Human-controlled publishing.**

[![PHP](https://img.shields.io/badge/PHP-8.0%2B-777BB4?logo=php&logoColor=white)](https://www.php.net/)
[![MySQL](https://img.shields.io/badge/MySQL-5.7%2B%20%7C%208.0-4479A1?logo=mysql&logoColor=white)](#requirements)
[![HTTPS](https://img.shields.io/badge/Transport-HTTPS%20required-15803d)](#security)
[![Draft Only](https://img.shields.io/badge/Publishing-DRAFT%20ONLY-d97706)](#editorial-safety)

*A small, isolated API that lets Nyamal submit stories to a private Naath Heritage review inbox — without touching the website's existing publishing tables.*

</div>

---

## ✦ At a glance

| | |
|---|---|
| **Source** | Nyamal AI |
| **Destination** | Naath Heritage editorial inbox |
| **Transport** | HTTPS · JSON · REST |
| **Storage** | Separate MySQL table: `nyamal_content_inbox` |
| **Submission state** | `pending_review` — enforced by server |
| **Public publishing** | **Not supported by this connector** |

> [!IMPORTANT]
> **Nothing is published automatically.** Every submission lands in the isolated inbox as `pending_review`. An editor must review it and use the website's existing publishing process. This connector does not modify existing news or history tables.

## Workflow

```mermaid
flowchart LR
    A["Nyamal AI<br/>Create content"] -->|HTTPS · Bearer token| B["Naath Heritage API<br/>Authenticate & validate"]
    B --> C[("Isolated MySQL inbox")]
    C --> D["Pending editorial review"]
    D --> E["Human editor"]
    E -->|Existing website workflow| F["Publish manually, if approved"]
```

## What's included

| File | Purpose |
|---|---|
| `nyamal-api.php` | Authenticated, draft-only submission endpoint |
| `nyamal-api-config.example.php` | Configuration template — safe to commit |
| `create_inbox_table.sql` | Creates the isolated inbox table only |
| `.htaccess` | Optional Apache HTTPS redirect and config-file protection |
| `INSTALL.md` | Step-by-step deployment checklist |
| `SECURITY.md` | Security notes and incident checklist |

## Quick setup

1. **Back up** your Naath Heritage database.
2. In phpMyAdmin, select the correct database and run [`create_inbox_table.sql`](create_inbox_table.sql).
3. Upload `nyamal-api.php` into a folder on your site, for example `/api/`.
4. Copy `nyamal-api-config.example.php` to `nyamal-api-config.php` beside the endpoint. Fill in database credentials and a unique random token.
5. Configure HTTPS and confirm the private config file cannot be downloaded.
6. In Nyamal, create a **Naath Heritage REST API** integration. Set the URL, POST method, Bearer token, and `force_draft: true`.
7. Send a test draft. Confirm it appears in the inbox with `pending_review`.

Read the complete [Installation Guide](INSTALL.md) before deploying.

## API endpoint

Example URL (change to match your deployment):

```text
https://naath.site.je/api/nyamal-api.php
```

### Request

`POST` with `Content-Type: application/json` and:

```http
Authorization: Bearer YOUR_LONG_RANDOM_TOKEN
```

Example body:

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

### Success response

```json
{
  "success": true,
  "message": "Draft received for editorial review.",
  "status": "pending_review",
  "id": 123
}
```

## Editorial safety

- The API **always** assigns `pending_review`.
- A request cannot change the status to `published`.
- No public news or history table is read or written.
- The connector creates one new inbox table only.
- Publishing, if approved, is a separate manual step in the existing CMS.

## Security baseline

- HTTPS required.
- Bearer-token authentication; token comparison uses `hash_equals`.
- POST-only; JSON-only.
- Request body size limit.
- Prepared statements.
- Input validation and URL validation.
- Config file excluded from Git.
- Rotate the token immediately if exposed.

See [`SECURITY.md`](SECURITY.md).

## Requirements

- PHP 8.0 or newer with PDO MySQL.
- MySQL 5.7+ / MySQL 8 compatible table support (InnoDB).
- HTTPS configured on the host.
- A database account limited to the needed database/table privileges.

## Status

This is a **standalone connector**. Connecting the inbox to the actual Naath Heritage admin dashboard or existing editorial workflow requires a separate implementation against that site's real PHP code and schema.

---

<div align="center">

**Built for responsible automation.**  
**Designed for editorial control.**  
**Protected by human review.**

*Nyamal AI × Naath Heritage*

</div>
