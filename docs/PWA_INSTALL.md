# Installing CreatorOS on Windows 11

CreatorOS installs as a hosted PWA. There is nothing to download and no
installer: Edge or Chrome turns the deployed site into a desktop app with its
own window, taskbar icon and Start-menu entry.

**You must install from the deployed HTTPS URL, not from localhost.** A
localhost install points at a dev server that will not be running.

## Verified

Against a local dev server, with a real browser:

- `/manifest.webmanifest` serves a valid manifest — name `CreatorOS — Foundry
  Management`, short name `CreatorOS`, `display: standalone`, `start_url: /`,
  `scope: /`, theme `#1c1d1b`, background `#f3f0e9`, three icons.
- `/icons/192` and `/icons/512` both return real `image/png` responses.
- The service worker registers, activates, and creates its cache.
- That cache contains exactly `/manifest.webmanifest`, `/icons/192`,
  `/icons/512` — no authenticated page and no API response.

Not yet verified: installation from the production HTTPS domain, because the
deployment has not been performed. See `docs/KNOWN_LIMITATIONS.md`.

## Install (Ezra and Payton each do this on their own machine)

### Microsoft Edge

1. Open `https://<your-creatoros-domain>` and sign in.
2. Click the **install icon** in the address bar (a monitor with a down arrow),
   or **Settings and more (…) → Apps → Install this site as an app**.
3. Name it **CreatorOS** and click **Install**.
4. Tick **Pin to taskbar** and **Pin to Start** when offered.

### Google Chrome

1. Open `https://<your-creatoros-domain>` and sign in.
2. Click the **install icon** in the address bar, or **⋮ → Cast, save and
   share → Install page as app**.
3. Confirm **Install**.

## After installing

- Launch from the Start menu or taskbar. It opens in its own window with no
  browser chrome.
- Each of you signs in with your **own** Foundry account. Do not share a login:
  every write is attributed to the signed-in user in the audit trail, and a
  shared account makes that attribution meaningless.
- Sign out from the avatar menu in the top-right.

## Updating

The app updates itself. The service worker caches only the manifest and icons,
so application code and data always come from the network — there is no stale
build to clear. If a change does not appear, `Ctrl+Shift+R` in the app window.

## Uninstalling

Windows **Settings → Apps → Installed apps → CreatorOS → Uninstall**, or in the
app window **… → Uninstall CreatorOS**. Uninstalling removes only the local
install; it changes nothing in CreatorOS.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No install icon | Not on HTTPS, or the manifest failed to load. Open DevTools → Application → Manifest. |
| Install icon on localhost but not production | Production build or deploy failed; check the Vercel deployment log. |
| Opens in a browser tab instead of its own window | Installed as a shortcut rather than an app. Uninstall and reinstall with **Install this site as an app**. |
| Signed out on every launch | Third-party cookie or site-data blocking for the domain. Allow site data for the CreatorOS domain. |
| Blank window after launch | `start_url` unreachable — usually the deployment is down or the domain changed. |
