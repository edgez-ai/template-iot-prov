# Mobile companion

The Expo app is the only device-onboarding client. It scans `PROV_` BLE
advertisements, derives the serial, establishes an ESP-IDF Security 1 session,
creates or reuses the Appwrite Device, sends its one-time MQTT credential to
`mqtt-config`, and provisions Wi-Fi. It also uses Appwrite Auth and reads
permitted telemetry directly from TablesDB.
Its Expo deep-link scheme is `edgez-devtools`, so application links begin with
`edgez-devtools://`.

BLE provisioning uses a native module and does not run in stock Expo Go.
`npm run android` starts Metro, forwards its port, and opens the project through
`edgez-devtools://` in EdgeZ Android DevTools on `127.0.0.1:5555`. It does not
run Gradle or build an APK. Override `ANDROID_SERIAL` or `EXPO_PORT` when needed.
