# Eagle AI - deploy guide (Render)

## 1. Firebase (one time)
Firebase Console -> Authentication -> Sign-in method -> **Email/Password** -> Enable.
Project Settings -> General -> **Web API Key** (idhu dhaan FIREBASE_API_KEY).

## 2. Render
1. Intha folder-a GitHub repo-la push pannu.
2. Render -> New -> Web Service -> repo select.
3. Build command: `npm install`   Start command: `npm start`
4. Environment variables:
   - `ANTHROPIC_API_KEY`  (console.anthropic.com key)
   - `FIREBASE_API_KEY`
   - `SESSION_SECRET`     (any long random text)
   - `CLAUDE_MODEL`       (optional, default claude-sonnet-5-5)
5. Deploy. "Server setup pending" error pogum.

## 3. Phone-la app maari install
Chrome-la site open -> menu (3 dots) -> **Add to Home screen / Install app**.
APK venumna: pwabuilder.com-la site URL kudu -> Android package download.

## Local test
`npm install` -> `.env` values-a export panni -> `node server.js` -> http://localhost:3000

Keys-a code-la / GitHub-la / chat-la ezhudhaadha. Render env vars-la mattum vei.
