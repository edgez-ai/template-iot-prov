# IoT Provisioning project guide

Read this file before changing this repository.

## Product

IoT Provisioning is an authenticated Appwrite example for onboarding ESP32-S3
devices and viewing MQTT telemetry. Web and mobile use Appwrite Auth and access
TablesDB directly under row-level permissions. The Function is reserved for
trusted MQTT ingestion and is the only MQTT-to-TablesDB writer.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `site/` | Next.js operator portal. Appwrite account sessions live here. |
| `app/` | Expo + React Native companion app. |
| `function/` | Appwrite Function; the only MQTT-to-TablesDB writer. |
| `firmware/` | PlatformIO + ESP-IDF device client and BLE provisioning. |
| `infra/` | Reproducible Appwrite CLI installer. |
| `README.md` | Setup guide and environment contract. |

Keep these boundaries. Never expose `APPWRITE_API_KEY` to clients. Authenticated
web and mobile clients read TablesDB directly; only the Function writes MQTT
telemetry.

Web and mobile call Appwrite's Devices API and query `telemetry` directly with
the active Appwrite session. Serial is the MQTT username and is unique within
the Appwrite project. MQTT telemetry inherits only the built-in device's read
permissions.

Firmware derives serial as 12 uppercase Wi-Fi MAC hex characters, advertises
`PROV_<serial>`, and accepts its Appwrite MQTT credential through the custom
BLE `mqtt-config` endpoint. It connects only to `mqtts://mqtt.edgez.ai:8883`,
publishes under `projects/<projectId>/devices/<serial>/telemetry/#`, and
subscribes under `projects/<projectId>/devices/<serial>/commands/#`.
It publishes the internal ESP32-S3 chip temperature every 30 seconds to the
`temp` telemetry channel; do not describe this reading as ambient temperature.

## Environment

The workspace supplies `APP_NAME`, `DOMAIN_SUFFIX`, `APPWRITE_ENDPOINT`,
`APPWRITE_PROJECT_ID`, `APPWRITE_PROJECT_NAME`, and `APPWRITE_API_KEY`.
Committed `.env.local` contains only non-secret resource IDs and timing values.

## Validation

- Web: `cd site && npm run typecheck && npm run build`
- Mobile: `cd app && npm run typecheck`
- Function: `cd function && npm run check`
- Infrastructure: `cd infra && npm run check`
- Firmware: `cd firmware && pio run`

Only run `infra/npm run deploy` when the user explicitly asks to change remote
Appwrite state.
