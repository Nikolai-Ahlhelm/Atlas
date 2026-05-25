# Dokumentenportal

Eine kleine Docusaurus-aehnliche Plattform fuer interne Dokumentation, Richtlinien oder Wissensseiten mit Markdown/HTML-Seiten, rollenbasiertem Zugriff, SQLite-Backend und Adminbereich.

## Start

```powershell
npm.cmd run dev
```

Danach ist die App standardmaessig unter `http://localhost:3000` erreichbar.

Beim ersten Start wird ein Admin-Benutzer angelegt:

- Benutzer: `admin@example.com`
- Passwort: `ChangeMe123!`

Bitte direkt im Adminbereich aendern.

## Docker

Die Anwendung benoetigt keinen separaten Datenbankdienst. SQLite-Daten liegen im Container unter `/app/data` und sollten als Volume persistiert werden.

```powershell
docker compose up --build
```

Wichtige Umgebungsvariablen:

- `PORT`: HTTP-Port im Container, Standard `3000`
- `HOST`: Bind-Adresse, im Container `0.0.0.0`
- `DATA_DIR`: Speicherort fuer SQLite, Standard im Dockerfile `/app/data`

## Startseite

Die Hauptseite liegt in `content/home.md`. Sie wird nach dem Login unter `/` angezeigt. Markdown und einfache HTML-Bloecke koennen gemischt werden, z. B. fuer Kacheln oder eigene Layouts.

## Inhalte und Navigation

Neue Richtlinien liegen in `content/docs`. Die Seitenleiste wird automatisch aus Ordnern und Markdown-Dateien erzeugt:

```text
content/docs/
  isms-grundlagen/
    category.json
    index.md
    informationssicherheitsleitlinie.md
```

`category.json` beschreibt den Navigationspunkt und optionale Rollen:

```json
{
  "label": "ISMS Grundlagen",
  "position": 1,
  "roles": ["isms-admin", "employee"]
}
```

`index.md` ist die Hauptseite der Kategorie und wird angezeigt, wenn die Kategorie angeklickt wird. Jede Markdown-Datei nutzt Frontmatter:
Mit `position` in `category.json` oder `sidebar_position` im Frontmatter kann die Reihenfolge gesteuert werden.

```md
---
title: Informationssicherheitsleitlinie
description: Grundsaetze und Verantwortlichkeiten.
roles: [isms-admin, employee]
owner: ISMS-Team
version: "1.0"
reviewDate: 2026-12-31
---
```

Rollen in einer Markdown-Datei ueberschreiben die Rollen der Kategorie. Ohne eigene Rollen erbt eine Seite die Rollen aus `category.json`.

## Design und Admin-Einstellungen

Im Adminbereich koennen Portalname, Sidebar-Titel, Logo, Standard-Sprache, Standard-Theme, Theme-Farbe, globale Schriftgroesse, Login-Texte, Login-Hintergrund, Entra-ID-Anmeldung, Rollenfarben und Menueleisten-Links angepasst werden. Fuer den Login-Hintergrund stehen ein statischer Hintergrund, eine Bild-URL und ein animierter Netzwerk-Hintergrund zur Auswahl.

## Sprachen

UI-Uebersetzungen liegen in `locales/*.json`. Vorhanden sind `de`, `en` und `fr`. Neue Sprachen koennen durch eine weitere JSON-Datei mit `code`, `flag`, `nativeName` und `ui`-Texten ergaenzt werden. Nutzer waehlen ihre Sprache im Profilmenue; ohne eigene Auswahl wird zuerst die Browser-Sprache verwendet und danach die im Adminbereich gesetzte Standard-Sprache.

Die obere Menueleiste wird ueber JSON konfiguriert:

```json
[
  { "label": "Richtlinien", "href": "/", "roles": [] },
  { "label": "Admin", "href": "/admin", "roles": ["isms-admin"] }
]
```

Nutzer koennen ueber ihren Namen oben rechts ihr Profil oeffnen und Name, E-Mail sowie Passwort selbst pflegen. Bei Aenderungen muss das aktuelle Passwort eingegeben werden; neue Passwoerter muessen bestaetigt werden. Gruppenmitgliedschaften werden dort angezeigt.

## Entra ID

Die Entra-Anmeldung ist optional. Setze dafuer Umgebungsvariablen:

```powershell
$env:ENTRA_TENANT_ID="..."
$env:ENTRA_CLIENT_ID="..."
$env:ENTRA_CLIENT_SECRET="..."
$env:ENTRA_REDIRECT_URI="http://localhost:3000/auth/entra/callback"
```

Wenn diese Werte fehlen, bleibt die lokale Anmeldung aktiv und der Entra-Button zeigt einen Hinweis.
