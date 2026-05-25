# Atlas

Atlas is a lightweight documentation portal for internal knowledge, policies, and team handbooks. It renders Markdown content with role-based access, an SQLite backend, and a built-in admin area.

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
