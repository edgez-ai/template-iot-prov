# IoT Provisioning

An Appwrite + Next.js + React Native + ESP32-S3 starter for authenticated device
onboarding and MQTT telemetry. It mirrors the five-part structure of Hello
Channels while giving each folder a provisioning-specific responsibility.

## Repository layout

| Folder | Purpose |
| --- | --- |
| `site/` | Next.js operator portal for sign-in, devices, and telemetry |
| `app/` | Expo + React Native companion app |
| `function/` | Trusted MQTT webhook that writes telemetry |
| `firmware/` | PlatformIO + ESP-IDF device client |
| `infra/` | Rerunnable Appwrite CLI installer |

Open `iot-provisioning.code-workspace` in VS Code to work on all five folders.

## Provisioning flow

1. An operator creates an Appwrite account or signs in from web/mobile.
2. Web or mobile creates an Appwrite Device with a project-unique serial, then
   creates its one-time MQTT credential directly through the Devices API.
3. The device publishes JSON to
   `projects/<projectId>/devices/<serial>/telemetry/<channel>`. Appwrite's EMQX
   ACL allows that serial to publish only beneath its own telemetry/events
   topics and subscribe only beneath its own commands topic.
4. Appwrite resolves the MQTT client and emits
   `devices.<deviceId>.mqtt.message.publish` to the Function.
5. The Function verifies the topic project and serial against the built-in
   device, then creates a telemetry row carrying its read permissions.
6. Web and mobile read permitted telemetry directly from TablesDB.

The firmware folder currently provides the ESP-IDF target and stable device
identity boundary. BLE Wi-Fi transport and MQTT publishing are the next device
increment.

## Environment

The managed workspace injects:

```sh
APP_NAME=<workspace-name>
DOMAIN_SUFFIX=edgez.biz
APPWRITE_ENDPOINT=<appwrite-endpoint>
APPWRITE_PROJECT_ID=<project-id>
APPWRITE_PROJECT_NAME=<dns-safe-project-name>
APPWRITE_API_KEY=<server-api-key>
```

The committed `.env.local` supplies `DATABASE_ID`, `TELEMETRY_TABLE_ID`, and
`POLL_INTERVAL_MS`. Export it for direct commands:

```sh
set -a
. ./.env.local
set +a
```

All clients derive the Function URL as
`https://${APPWRITE_PROJECT_NAME}-${APP_NAME}.functions.${DOMAIN_SUFFIX}`.
The web/mobile clients also receive the public Appwrite endpoint, project ID,
and non-secret table IDs. The API key is used by `infra/` only. Appwrite's
server-level EMQX secret remains outside this application repository.

## Local validation

Install dependencies in `site/`, `app/`, `function/`, and `infra/`, then run:

```sh
(cd site && npm run typecheck && npm run build)
(cd app && npm run typecheck)
(cd function && npm run check)
(cd infra && npm run check)
(cd firmware && pio run)
```

Remote installation is intentionally separate: run `cd infra && npm run deploy`
only when you intend to provision or update Appwrite resources.
