# Device firmware

The ESP32-S3 provisions Wi-Fi through ESP-IDF BLE provisioning and exposes a
custom `mqtt-config` endpoint. Send this JSON before applying Wi-Fi credentials:

```json
{
  "clientId": "device-uuid-from-appwrite",
  "username": "test123",
  "password": "one-time-device-secret",
  "projectId": "049391cf-9119-4ff3-9b64-3d92b70bd612",
  "channel": "test"
}
```

The broker is pinned in firmware to `mqtts://mqtt.edgez.ai:8883`. TLS validates
the broker's Let's Encrypt certificate chain through ESP-IDF's trusted root
certificate bundle; certificate verification is not disabled. The handler
validates the Appwrite serial syntax, stores the credential in NVS, and
publishes an online event to
`projects/<projectId>/devices/<serial>/telemetry/<channel>` after Wi-Fi and MQTT
connect. The Appwrite device must be created with `enabled: true`.

Production hardware should enable encrypted NVS/flash encryption. Credentials
must never be compiled into source or logged.
