# Mobile companion

The Expo app is the only device-onboarding client. It scans `PROV_` BLE
advertisements, derives the serial, establishes an ESP-IDF Security 1 session,
creates or reuses the Appwrite Device, sends its one-time MQTT credential to
`mqtt-config`, and provisions Wi-Fi. It also uses Appwrite Auth and reads
permitted telemetry directly from TablesDB.
Its Expo deep-link scheme is `edgez-devtools`, so application links begin with
`edgez-devtools://`.

BLE provisioning uses a native module and does not run in stock Expo Go. Use
`npm run android` to build and install an Android development application that
contains the provisioning module.
