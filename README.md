# Secure Notes Frontend

A minimal, functional frontend for the [Secure Notes API](https://github.com/AkibUllah/secure-notes-backend),
written in plain HTML and JavaScript (no frameworks, templates or build step).

**Live:** _added after deployment_

## Features

- Register, log in and log out (logout also revokes the token on the server)
- My notes: create, edit, delete, paginated list
- Posts: public feed, write and edit your own, and all posts of one author (Scenario 2, `$lookup`)
- Interests: users grouped by interest, with a paged view of one group (Scenario 1)
- Profile: change name, interests and password
- Admin only: manage users and view everyone's notes

## Run locally

Start the API first (see the backend README), then serve this folder on port 5173:

```bash
python3 -m http.server 5173     # or: npx serve -l 5173
```

Open http://localhost:5173. On `localhost` the app calls the API at `http://localhost:3000`.

## Configuration

`config.js` sets `window.API_URL`, the backend address used when the site is deployed. The
Content-Security-Policy in `index.html` only allows API calls to that backend.

## Security

All user content is rendered with `textContent`, never `innerHTML`, so it cannot inject HTML or
scripts. The CSP blocks inline scripts and `eval`. The JWT is kept in `localStorage`.

## Files

```
index.html   page layout
app.js       all client logic
config.js    backend URL
```
