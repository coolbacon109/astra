# Astra

## Important Note About GitHub Pages vs Node.js
- **GitHub Pages** only serves static files (`index.html`, `assets/`, `clever-cloak/`). It **cannot** run `server.js` (Scramjet/Ultraviolet proxy, Wisp WebSockets, `/api/auth/*`, `/api/chat/*`, `/api/music/*`, `/api/ai/chat`).
- To run the **full Astra proxy + chat + music + AI**: deploy this exact folder to a Node.js host (**Koyeb**, **Oracle Cloud Always Free**, **Railway**, **Fly.io**, or **Cloudflare Tunnel**) with:
  - Build command: `npm install`
  - Start command: `node --max-http-header-size=131072 server.js`

## Uploading to GitHub (Why Web Upload Failed)
- The 4K theme `.mp4` videos in `assets/` are **27–60 MB** each. GitHub's browser drag-and-drop rejects files over **25 MB**, whereas `git push` allows files up to **100 MB**.
- Push from PowerShell inside this folder:
  ```powershell
  git init
  git add .
  git commit -m "Initial Astra upload"
  git branch -M main
  git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
  git push -u origin main
  ```
