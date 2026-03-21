# my-app

An Electron application with React

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## DAT Decrypt Setup

The `Drone Data Decrypt` tab requires a real decoder.

1. Install Java.
2. Get `DatCon.jar`.
3. Set environment variable `DATCON_PATH` to the full path of `DatCon.jar`.

Example (PowerShell):

```powershell
$env:DATCON_PATH = "D:\\tools\\DatCon.jar"
npm run dev
```

Without `DATCON_PATH`, decrypt will fail with a clear configuration error instead of generating placeholder outputs.
