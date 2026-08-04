# Next.js operator portal

The Next.js client uses Appwrite email/password sessions and directly accesses
TablesDB. Appwrite row permissions restrict device and telemetry visibility to
the signed-in owner. The Function is not used for dashboard reads.
The Site lists Devices but never creates them or MQTT credentials. Onboarding
is exclusively available from the React Native app over BLE.
