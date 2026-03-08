## Nexus Download Manager Repository Documentation

"Every byte. Every site. Insanely fast."

This repository, `engrmaziz/nexus`, hosts the Nexus Download Manager, a high-performance tool for downloading files and videos from various websites. The project is structured as a monorepo containing two main components: a desktop application built with Electron and a browser extension for Chrome-compatible browsers.

### Overview
- **Name**: Nexus Download Manager
- **Tagline**: "Every byte. Every site. Insanely fast."
- **Language**: JavaScript
- **License**: MIT (for the desktop component)
- **Created**: Approximately 2 days ago (as of 2026-03-08)
- **Repository URL**: https://github.com/engrmaziz/nexus

The repository includes a `.gitignore` file that excludes common artifacts like video files (e.g., `.mp4`, `.mkv`), `node_modules`, build outputs (`dist`), logs, and temporary files.

### Components

#### 1. Nexus Desktop (`nexus-desktop/`)
This is an Electron-based desktop application that serves as the core download manager. It includes a backend server (using Express) and a frontend renderer.

**Key Features** (inferred from dependencies):
- **Download Management**: Supports downloading files, videos, and media from various sources using libraries like `axios`, `got`, and `node-fetch`.
- **Video Processing**: Integrates FFmpeg for video manipulation (e.g., conversion, extraction) via `fluent-ffmpeg` and `ffmpeg-static`.
- **Web Scraping and Parsing**: Uses `cheerio` for HTML parsing, `fast-xml-parser` for XML, and parsers for M3U8 and MPD playlists (`m3u8-parser`, `mpd-parser`).
- **File Handling**: Includes `adm-zip` for archives, `tar` for tarballs, `file-type` for MIME detection, and `sanitize-filename` for safe naming.
- **Security and Utilities**: Features `crypto-js` for encryption, `helmet` for security headers, `uuid` for unique IDs, and `winston` for logging.
- **Concurrency Control**: Uses `p-queue` and `p-limit` for managing concurrent downloads.
- **Real-time Communication**: Implements Socket.IO for live updates.
- **Database**: Uses `sql.js` for in-memory SQLite database operations.

**Scripts** (from `package.json`):
- `npm start`: Launches the Electron app.
- `npm run dev`: Runs in development mode with `NODE_ENV=development`.
- `npm run build`: Builds distributables using `electron-builder`.
- `npm run pack`: Creates a directory build.

**Build Configuration**:
- Supports Windows (NSIS installer), macOS (DMG), and Linux (AppImage, DEB).
- App ID: `com.nexus.downloader`
- Output directory: `dist`
- Includes `main/`, `renderer/`, and `node_modules/` in builds.

**Dependencies**:
A comprehensive list including production deps like `express`, `socket.io`, `axios`, etc., and dev deps `electron` and `electron-builder`.

For more details on the desktop app's architecture, refer to the `main/` and `renderer/` directories (not fully explored here).

#### 2. Nexus Extension (`nexus-extension/`)
This is a Manifest V3 browser extension designed to integrate with web browsers for initiating downloads directly from supported sites.

**Key Features** (from `manifest.json`):
- **Supported Sites**: Content scripts target YouTube, Facebook, Instagram, Twitter (X), Vimeo, TikTok, and generic sites.
- **Functionality**: Includes video buttons, download interceptors, playlist handling, and quality selection panels.
- **Permissions**: Extensive permissions for `webRequest`, `webNavigation`, `declarativeNetRequest`, `activeTab`, `scripting`, `storage`, `tabs`, `notifications`, `downloads`, and `contextMenus`. Host permissions allow access to all URLs.
- **Components**:
  - **Background Script**: Service worker at `background/background.js` for handling requests and logic.
  - **Content Scripts**: Injected into all frames on any site, running at document idle.
  - **Popup**: Default popup at `popup/popup.html` with icons.
  - **Options Page**: Settings at `options/options.html`.
  - **Icons**: PNG icons at 16x16, 48x48, and 128x128 in `icons/`.
- **Web Accessible Resources**: Icons are accessible from any URL.

**Structure**:
- `background/`: Background service worker logic.
- `content/`: Content scripts, including site-specific handlers (e.g., `sites/youtube.js`).
- `icons/`: Icon assets.
- `options/`: Options page files.
- `popup/`: Popup UI files.

The extension likely communicates with the desktop app for actual downloading, though the exact integration mechanism requires examining the code.

### Installation and Usage
1. **Clone the Repository**:
   ```
   git clone https://github.com/engrmaziz/nexus.git
   cd nexus
   ```

2. **Desktop App**:
   - Navigate to `nexus-desktop/`.
   - Install dependencies: `npm install`.
   - Run in development: `npm run dev`.
   - Build for production: `npm run build`.

3. **Browser Extension**:
   - Load the `nexus-extension/` folder as an unpacked extension in your browser's developer mode (e.g., Chrome: `chrome://extensions/`).
   - Ensure the desktop app is running to handle downloads.

### Additional Notes
- The repository is in early development (created recently), so features may be incomplete or evolving.
- No additional documentation files (e.g., in a `docs/` folder) were found beyond the minimal README.
- For code-specific details, explore the source files in the respective directories.
- If you encounter issues, check the GitHub issues or create a new one.

For the latest updates, visit the [repository on GitHub](https://github.com/engrmaziz/nexus).
