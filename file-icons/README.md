# file-icons

Herdr's Files panel with the icons of VS Code's [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme): a lazy file browser for the folder of the focused pane, with git status marks and read-only previews. It also gives the icon set to [git-panel](../git-panel).

This mod is from [cybertron288/herdr-mods](https://github.com/cybertron288/herdr-mods/tree/main/file-icons). This copy moves the icon lookup into `lookup.js`, so that other mods can copy it.

## Install

Copy the mod folder into your Herdr home as a real folder, not a symlink, or run `./install.sh` at the root of this repo.

```sh
cp -r mods/file-icons ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/file-icons
```

To use it as your Files panel:

```json
{ "id": "files", "type": "block", "content": { "mod": "file-icons" } }
```

## Use the icons in another mod

A mod cannot import a file from another mod, so copy `lookup.js` and `icons.js` into your mod. The SVG files stay in this mod, so it must be installed too.

```js
import { image } from "gpui-kit";
import { settings } from "herdr";
import { icon } from "./lookup.js"; // a copy of file-icons' lookup.js and icons.js

image(icon("src/app.ts", false, false, Boolean(settings().dark))).size(16)
```

`icon(path, dir, open, dark)` returns the icon path for a file, or for a folder (`dir`), open or closed. The rules are the ones VS Code applies: a path rule beats a name, a name beats an extension, and the longest extension wins. A light theme checks the light table first.

## Contents

- `icons/`: about 1,180 SVG icons.
- `icons.js`: the icon for each file name, extension and folder name.
- `lookup.js`: `icon()`.
- `LICENSE-material-icon-theme.txt`: the icons' MIT licence.

## Licence

MIT (`LICENSE`, © cybertron288). The panel is based on Herdr's own `files` mod (Apache-2.0). The icons are from Material Icon Theme (MIT).
