# Mobile companion

The Expo app is the only device-onboarding client. It scans `PROV_` BLE
advertisements and derives the serial. After the operator selects a device,
the example proof of possession (PoP) `abcd1234` is prefilled to match the
firmware and the value shown on its OLED. The app establishes an ESP-IDF
Security 1 session, asks the ESP32 to scan nearby Wi-Fi networks, and lets the
operator select an SSID and enter its password. It then creates or
reuses the Appwrite Device, sends its one-time MQTT credential to `mqtt-config`,
and provisions Wi-Fi. It also uses Appwrite Auth and reads permitted telemetry
directly from TablesDB.

The provisioning button opens a three-step dialog for selecting the BLE device,
confirming its labeled name and PoP fields, and selecting the scanned Wi-Fi
network. The Wi-Fi password field is shown only for secured networks.
Its Expo deep-link scheme is `edgez-devtools`, so application links begin with
`edgez-devtools://`.

BLE provisioning uses a native module and does not run in stock Expo Go.
`npm run android` starts Metro, forwards its port, and opens the project through
`edgez-devtools://` in EdgeZ Android DevTools on `127.0.0.1:5555`. It does not
run Gradle or build an APK. Override `ANDROID_SERIAL` or `EXPO_PORT` when needed.
