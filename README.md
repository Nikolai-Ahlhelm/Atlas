# Atlas

Atlas is a lightweight documentation portal for internal knowledge, policies, and team handbooks. It renders Markdown content with role-based access, an SQLite backend, and a built-in admin area.

> [!NOTE]
> This project is built with the help of AI. (Code and translations)


## Start

```powershell
npm.cmd run dev
```

The app is available at `http://localhost:3000`.

Default admin account:

- Email: `admin@example.com`
- Password: `ChangeMe123!`

Change the password after the first sign-in.

## Docker

Atlas uses SQLite and does not require a separate database service.

```powershell
docker compose up --build
```

Useful environment variables:

- `PORT`: HTTP port inside the container, default `3000`
- `HOST`: bind address, `0.0.0.0` in Docker
- `DATA_DIR`: SQLite storage path, default `/app/data`

## Pull from GHCR

The repository is prepared to publish a Docker image automatically via GitHub Actions to GitHub Container Registry.

Pull the latest published image:

```bash
docker pull ghcr.io/nikolai-ahlhelm/atlas:latest
```

Run it with a persistent volume for SQLite:

```bash
docker run -d \
  --name atlas \
  -p 3000:3000 \
  -v atlas-data:/app/data \
  ghcr.io/nikolai-ahlhelm/atlas:latest
```

Or with Docker Compose:

```powershell
docker compose up -d
```

Example `docker-compose.yaml` for the published GHCR image:

```yaml
services:
  atlas:
    image: ghcr.io/nikolai-ahlhelm/atlas:latest
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3000
      DATA_DIR: /app/data
    volumes:
      - atlas-data:/app/data
    restart: unless-stopped

volumes:
  atlas-data:
```

The checked-in `docker-compose.yml` in this repository is still useful for local self-builds while developing Atlas itself.

The GitHub workflow publishes new images on pushes to `master`, on published releases, and on manual workflow runs.

## Content structure

The home page lives in `content/home.md`. Documentation pages live in `content/docs`, and the sidebar is generated from folders plus optional `category.json` files.

```text
content/
  home.md
  docs/
    getting-started/
      category.json
      index.md
      authoring-content.md
```

Example `category.json`:

```json
{
  "label": "Getting Started",
  "position": 1,
  "roles": ["Users"]
}
```

Example frontmatter:

```md
---
title: Authoring Content
description: Use Markdown files and folders to grow the documentation space.
roles: [Users]
owner: Atlas
version: "1.0"
reviewDate: 2027-01-01
---
```

## Admin area

The admin portal can manage users, roles, branding, login copy, themes, menu links, and Entra ID settings. It also includes a factory reset action that clears SQLite data and restores the default Atlas setup.

## Database behavior

If `data.sqlite` is deleted and the app is started again, Atlas recreates the database automatically and seeds it with the default Admin account, roles, and settings.


<br>

_________________


<br>

# 📒 Changelog

## Version 0.3.0
- New: CMS system (role-based CMS system)
- New: Blog system (role-based blog post system)
- New: Forms system (role-based forms with designer)
- New: Download center (role-based file sharing)
- New: Translations in many languages
- New: Freedom of design, change opacity and colors of everything
- Change: Features refactored to standalone plugins
- Change: Navbar redesign -> Buttons moved to user menu
- Change: Redesigned admin menu 
- Change: Minor design improvements
- Fixed countless bugs

## Version 0.2.0 
- Major design overhaul 

## Version 0.1.1 
- New: Logo
- New: Reset option
- New: Multilanguage support
- Change: Setup / Initial pages redesigned to function as a guide for Atlas
- Change: Improved visual style of sidebar
- Change: Iprooved breadcrumb bar
- Change: Polished UI design/style
- Fix: Create User/Role not working
- Fix: Incorrect display of theme mode switch

## Version 0.1.0 - Initial Release




