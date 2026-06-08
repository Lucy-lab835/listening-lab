# Listening Lab

A small React app that turns text into listening audio with Gemini TTS.

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env.local` and set:

   ```bash
   VITE_GEMINI_API_KEY=your_google_ai_studio_api_key
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

## GitHub Pages deployment

This project includes `.github/workflows/deploy.yml`.

1. Push the project to a GitHub repository.
2. In GitHub, go to `Settings > Secrets and variables > Actions`.
3. Add `VITE_GEMINI_API_KEY`.
4. Optional: add the Firebase `VITE_FIREBASE_*` secrets if you want cloud sync.
5. Go to `Settings > Pages` and set the source to `GitHub Actions`.
6. Push to the `main` branch.

Without Firebase settings, the app still works and saves the latest text and voice in local browser storage.
