# App startup

Always start the app bound to `0.0.0.0` so it is reachable from other devices. Start Vite with `npm run dev -- --host 0.0.0.0` and use `HOST=0.0.0.0` for the backend. Preserve the backend's required authentication and encryption configuration when using this host.
