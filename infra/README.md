# Appwrite infrastructure

`npm run deploy` enables email/password auth, disables anonymous auth,
registers web and Android platforms, and installs the row-secured telemetry
table, event-driven MQTT Function, static Next.js Site, variables, and domains.
Devices and MQTT credentials use Appwrite's built-in per-project Devices API.

This changes remote state. Use `npm run check` for local syntax validation.
