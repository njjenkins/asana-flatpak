# asana-flatpak

An unofficial, tabbed desktop wrapper for [Asana](https://asana.com) on Linux, packaged as a Flatpak and styled to fit in on GNOME.

> [!IMPORTANT]
> **This project is not affiliated with, endorsed by, or sponsored by Asana, Inc.**
> "Asana" and the Asana logo are trademarks of Asana, Inc. This is an independent, community-made wrapper around the Asana web app at `app.asana.com`. It does not modify Asana's service, and your use of Asana remains subject to [Asana's terms](https://asana.com/terms). For official clients, see [asana.com/download](https://asana.com/download).

## Why

Asana ships desktop apps for macOS and Windows, but not for Linux. The existing Linux options are mostly single-window wrappers or Snaps. This app gives you:

- **Tabs**, like the macOS app: open several projects, tasks, or inboxes side by side.
- **A native GNOME look**: a libadwaita-style header bar with the tabs built in, Adwaita window controls, and a dimmed style when the window is unfocused.
- **Light/dark mode that follows Asana.** The header bar matches whatever theme the Asana page is showing, whether Asana is set to Light, Dark, or System.
- **Its own launcher and dock icon**, as a normal Flatpak app.
- **A persistent login.** Your session is kept between launches.

## Features

- Tabs with favicons and loading spinners; drag to reorder, middle-click to close
- Your tabs and window size come back on the next launch. Only the tab you were on loads right away; the others load when you first click them.
- Desktop notifications from Asana; clicking one brings the window forward and switches to the tab it came from
- Right-click menu with cut/copy/paste, spelling suggestions, and link actions
- Asana links that open new windows (e.g. "open in new tab") open as tabs; non-Asana links and `mailto:` links open in your default apps
- Google, Microsoft, Apple, Okta, and OneLogin sign-in pages load inside the app so SSO works
- Window buttons follow your GNOME button layout (`org.gnome.desktop.wm.preferences button-layout`)
- Opening the app again focuses the existing window instead of starting a second copy
- Sandboxed: the Flatpak gets network, display, audio, and Downloads-folder access only, and notifications go through the desktop portal. Inside the app, Asana's pages can only use notifications, clipboard writes, and fullscreen. Camera, microphone, location, and device access are always denied.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> | New tab |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> | Close tab |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> | Next / previous tab |
| <kbd>Ctrl</kbd>+<kbd>PgDn</kbd> / <kbd>Ctrl</kbd>+<kbd>PgUp</kbd> | Next / previous tab |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>PgDn</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>PgUp</kbd> | Move tab right / left |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>8</kbd> | Go to tab 1–8 |
| <kbd>Ctrl</kbd>+<kbd>9</kbd> | Go to last tab |
| <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd> | Back / forward |
| <kbd>Ctrl</kbd>+<kbd>R</kbd> or <kbd>F5</kbd> | Reload |
| <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> | Zoom in / out / reset |
| <kbd>F11</kbd> | Toggle fullscreen |

## Installing

Install the Flatpak from the [latest release](https://github.com/njjenkins/asana-flatpak/releases/latest). It runs on x86_64 Linux and needs Flatpak with the Flathub remote, which most distributions, including Fedora, already have set up.

1. If you don't have Flathub yet, add it. The app's runtime comes from there:

   ```sh
   flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
   ```

2. Download the latest release and install it:

   ```sh
   curl -LO https://github.com/njjenkins/asana-flatpak/releases/latest/download/asana-flatpak-x86_64.flatpak
   flatpak install --user asana-flatpak-x86_64.flatpak
   ```

   Flatpak will offer to install the Freedesktop 25.08 runtime from Flathub if you don't already have it.

"Asana" will appear in your app grid and can be pinned to the dock.

### Updating

Releases don't update automatically. To update, download the new file and reinstall it. Your login, tabs, and settings are kept.

```sh
curl -LO https://github.com/njjenkins/asana-flatpak/releases/latest/download/asana-flatpak-x86_64.flatpak
flatpak install --user --reinstall asana-flatpak-x86_64.flatpak
```

Then quit and reopen the app.

### Uninstalling

```sh
flatpak uninstall --user --delete-data io.github.njjenkins.asana_flatpak
```

`--delete-data` also removes your saved login and tabs. Leave it off to keep them.

## Building from source

You need Node.js (with npm), `flatpak`, `flatpak-builder`, and the Flathub remote.

On Fedora:

```sh
sudo dnf install nodejs npm flatpak-builder
flatpak install flathub org.freedesktop.Sdk//25.08 org.electronjs.Electron2.BaseApp//25.08
```

Then build and install:

```sh
git clone https://github.com/njjenkins/asana-flatpak.git
cd asana-flatpak
npm install
npm run dist
flatpak install --user --reinstall dist/asana-flatpak-x86_64.flatpak
```

To run it from source without packaging:

```sh
npm start
```

### Publishing a release

1. Bump `version` in `package.json`.
2. Run `npm run dist`.
3. Create a GitHub release and attach `dist/asana-flatpak-x86_64.flatpak` **without renaming it**. The install command above downloads that exact filename from the latest release.

## How it works

It's a small [Electron](https://www.electronjs.org/) app. The window is frameless and draws its own header bar (`src/headerbar/`). Each tab is a separate `WebContentsView` that loads `app.asana.com`. All tabs share one persistent session, so they stay logged in together. A small preload script in each tab (`src/page-preload.js`) samples the page's rendered background color to tell whether Asana is showing its light or dark theme, so the header can match. Web content runs sandboxed with context isolation, and the header bar talks to the main process (`src/main.js`) through a minimal preload bridge.

### Notifications

For desktop notifications, turn on Asana's desktop/browser notifications in Asana's own notification settings. The app grants the permission automatically, so there's no browser prompt.

## License

Copyright (C) 2026 Noah Jenkins

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE) for the full text.

The license covers this wrapper's source code only. It grants no rights to Asana's name, logo, or service.
