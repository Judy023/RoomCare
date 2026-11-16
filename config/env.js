// Loads an optional .env file (KEY=value lines) into process.env before anything reads it.
// Real environment variables always win; a missing .env is fine. Never commit .env — see .env.example.
try {
  process.loadEnvFile?.();
} catch {
  // no .env file
}
