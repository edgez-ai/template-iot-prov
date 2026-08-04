import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, PermissionsAndroid, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Account, Client, ID, Models, Query, TablesDB } from "react-native-appwrite";
import { ESPDevice, ESPProvisionManager, ESPSecurity, ESPTransport } from "@orbital-systems/react-native-esp-idf-provisioning";

type Device = { $id: string; serial: string; name: string; status: string; enabled: boolean };
type Credential = { clientId: string; username: string; password: string };
type Telemetry = Models.Row & { deviceId: string; serial: string; channel: string; topic: string; payload: string; receivedAt: string };
type AppConfig = { appwriteEndpoint: string; appwriteProjectId: string; appwritePlatform: string; databaseId: string; telemetryTableId: string };

const appConfig = Constants.expoConfig?.extra as AppConfig | undefined;
if (!appConfig) throw new Error("Expo Appwrite configuration is missing");
const config: AppConfig = appConfig;
const endpoint = config.appwriteEndpoint.replace(/\/+$/, "");
const client = new Client().setEndpoint(endpoint).setProject(config.appwriteProjectId).setPlatform(config.appwritePlatform);
const account = new Account(client);
const tables = new TablesDB(client);

function messageOf(error: unknown) { return error instanceof Error ? error.message : "Something went wrong."; }

function serialFromBleName(name: string) {
  const serial = name.startsWith("PROV_") ? name.slice(5).toUpperCase() : "";
  if (!/^[A-F0-9]{12}$/.test(serial)) throw new Error(`Invalid provisioning name: ${name}`);
  return serial;
}

async function requestBlePermissions() {
  if (Platform.OS !== "android") return;
  const permissions = Number(Platform.Version) >= 31
    ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const results = await PermissionsAndroid.requestMultiple(permissions);
  if (permissions.some((permission) => results[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
    throw new Error("Bluetooth permission is required to discover and provision devices.");
  }
}

async function deviceApi<T>(path = "", method: "GET" | "POST" = "GET", body?: object) {
  const jwt = await account.createJWT();
  const response = await fetch(`${endpoint}/devices${path}`, {
    method,
    headers: { "content-type": "application/json", "x-appwrite-project": config!.appwriteProjectId, "x-appwrite-jwt": jwt.jwt },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || "Appwrite Devices request failed.");
  return payload;
}

export default function App() {
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bleDevices, setBleDevices] = useState<ESPDevice[]>([]);
  const [selectedBleDevice, setSelectedBleDevice] = useState<ESPDevice | null>(null);
  const [name, setName] = useState("");
  const [ssid, setSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [provisioningStatus, setProvisioningStatus] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [deviceResult, telemetryResult] = await Promise.all([
      deviceApi<{ devices: Device[] }>(),
      tables.listRows({ databaseId: config!.databaseId, tableId: config!.telemetryTableId, queries: [Query.orderDesc("receivedAt"), Query.limit(30)] }),
    ]);
    setDevices(deviceResult.devices);
    setTelemetry(telemetryResult.rows as unknown as Telemetry[]);
  }, []);

  useEffect(() => {
    account.get().then(async (current) => { setUser(current); await refresh(); }).catch(() => undefined).finally(() => setBusy(false));
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh, user]);

  async function authenticate(register: boolean) {
    setBusy(true); setError("");
    try {
      if (register) await account.create({ userId: ID.unique(), email, password });
      await account.createEmailPasswordSession({ email, password });
      setUser(await account.get());
      await refresh();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }

  async function scanBleDevices() {
    setBusy(true); setError(""); setProvisioningStatus("Scanning for PROV_ devices…");
    try {
      await requestBlePermissions();
      const found = await ESPProvisionManager.searchESPDevices("PROV_", ESPTransport.ble, ESPSecurity.secure);
      const valid = found.filter((device) => /^PROV_[A-F0-9]{12}$/i.test(device.name));
      setBleDevices(valid);
      setProvisioningStatus(valid.length ? "Select a device to provision." : "No provisioning devices found.");
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }

  async function provisionDevice() {
    if (!selectedBleDevice) return;
    setBusy(true); setError(""); setProvisioningStatus("Connecting securely over BLE…");
    try {
      const serial = serialFromBleName(selectedBleDevice.name);
      const proofOfPossession = serial.slice(-8).toLowerCase();
      await selectedBleDevice.connect(proofOfPossession);

      setProvisioningStatus("Creating Appwrite device credential…");
      let appwriteDevice = devices.find((device) => device.serial === serial);
      if (!appwriteDevice) {
        appwriteDevice = await deviceApi<Device>("", "POST", {
          serial,
          name: name.trim() || serial,
          enabled: true,
        });
      }
      const mqtt = await deviceApi<Credential>(`/${encodeURIComponent(appwriteDevice.$id)}/credentials`, "POST", {});

      setProvisioningStatus("Sending MQTT credential to the device…");
      const mqttResponse = await selectedBleDevice.sendData("mqtt-config", JSON.stringify({
        clientId: mqtt.clientId,
        username: mqtt.username,
        password: mqtt.password,
        projectId: config.appwriteProjectId,
        channel: "status",
      }));
      const accepted = JSON.parse(mqttResponse) as { ok?: boolean };
      if (!accepted.ok) throw new Error("The device rejected its MQTT credential.");

      setProvisioningStatus("Sending Wi-Fi credentials…");
      const result = await selectedBleDevice.provision(ssid.trim(), wifiPassword);
      if (result.status && !/success|connected/i.test(result.status)) {
        throw new Error(`Wi-Fi provisioning failed: ${result.status}`);
      }
      setProvisioningStatus(`Provisioned ${serial}. Waiting for temperature telemetry.`);
      setSelectedBleDevice(null); setBleDevices([]); setName(""); setSsid(""); setWifiPassword("");
      await refresh();
    } catch (caught) { setError(messageOf(caught)); setProvisioningStatus("Provisioning did not complete."); }
    finally { selectedBleDevice.disconnect(); setBusy(false); }
  }

  async function signOut() {
    await account.deleteSession({ sessionId: "current" });
    setUser(null); setDevices([]); setTelemetry([]); setBleDevices([]); setSelectedBleDevice(null);
  }

  const deviceNames = useMemo(() => new Map(devices.map((device) => [device.$id, device.name])), [devices]);
  if (busy && !user) return <SafeAreaView style={styles.safe}><ActivityIndicator style={styles.loader} color="#62d8cf" size="large" /></SafeAreaView>;

  return <SafeAreaView style={styles.safe}><StatusBar style="light" /><KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={styles.header}><View><Text style={styles.eyebrow}>APPWRITE DEVICES · MQTT</Text><Text style={styles.title}>{user ? "Device telemetry" : "Operator access"}</Text></View>{user && <Pressable onPress={signOut}><Text style={styles.signOut}>SIGN OUT</Text></Pressable>}</View>
    {!user ? <View style={styles.auth}>
      <Text style={styles.hero}>Devices in.{"\n"}<Text style={styles.accent}>Signals out.</Text></Text>
      <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor="#718a83" autoCapitalize="none" keyboardType="email-address" />
      <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor="#718a83" secureTextEntry />
      <Pressable style={styles.primary} onPress={() => authenticate(false)} disabled={busy}><Text style={styles.primaryText}>SIGN IN</Text></Pressable>
      <Pressable style={styles.secondary} onPress={() => authenticate(true)} disabled={busy}><Text style={styles.secondaryText}>CREATE ACCOUNT</Text></Pressable>
    </View> : <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}><Text style={styles.cardTitle}>Provision device over BLE</Text>
        <Pressable style={styles.primary} onPress={scanBleDevices} disabled={busy}><Text style={styles.primaryText}>{busy ? "WORKING…" : "SCAN PROV_ DEVICES"}</Text></Pressable>
        {bleDevices.map((device) => <Pressable key={device.name} style={[styles.bleDevice, selectedBleDevice?.name === device.name && styles.bleDeviceSelected]} onPress={() => setSelectedBleDevice(device)}><Text style={styles.deviceNameDark}>{device.name}</Text><Text style={styles.muted}>Serial {device.name.slice(5).toUpperCase()}</Text></Pressable>)}
        {selectedBleDevice && <>
          <TextInput style={styles.inputLight} value={name} onChangeText={setName} placeholder="Display name" maxLength={128} />
          <TextInput style={styles.inputLight} value={ssid} onChangeText={setSsid} placeholder="Wi-Fi SSID" autoCapitalize="none" />
          <TextInput style={styles.inputLight} value={wifiPassword} onChangeText={setWifiPassword} placeholder="Wi-Fi password" secureTextEntry />
          <Pressable style={styles.primary} onPress={provisionDevice} disabled={busy || !ssid.trim()}><Text style={styles.primaryText}>PROVISION DEVICE</Text></Pressable>
        </>}
        {provisioningStatus ? <Text style={styles.muted}>{provisioningStatus}</Text> : null}
      </View>
      <Text style={styles.sectionLabel}>{devices.length} DEVICES · {telemetry.length} RECENT MESSAGES</Text>
      {telemetry.map((row) => <View style={styles.telemetry} key={row.$id}><View style={styles.telemetryHeader}><Text style={styles.deviceName}>{deviceNames.get(row.deviceId) || row.serial}</Text><Text style={styles.time}>{new Date(row.receivedAt).toLocaleTimeString()}</Text></View><Text style={styles.topic}>{row.topic}</Text><Text style={styles.payload}>{JSON.stringify(JSON.parse(row.payload), null, 2)}</Text></View>)}
      {!telemetry.length && <Text style={styles.empty}>No MQTT telemetry yet.</Text>}
    </ScrollView>}
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </KeyboardAvoidingView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#092e35" }, loader: { flex: 1 }, screen: { flex: 1, paddingHorizontal: 22, paddingTop: 18 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 20 }, eyebrow: { color: "#69cfc7", fontSize: 10, fontWeight: "900", letterSpacing: 1.4 }, title: { color: "#fff", fontSize: 28, fontWeight: "800", marginTop: 3 }, signOut: { color: "#90aaa7", fontSize: 10, fontWeight: "800" },
  auth: { flex: 1, justifyContent: "center", gap: 12, paddingBottom: 40 }, hero: { color: "white", fontSize: 45, lineHeight: 51, fontWeight: "900", letterSpacing: -1.8, marginBottom: 24 }, accent: { color: "#ff8264" },
  input: { height: 58, borderWidth: 1, borderColor: "#36565b", borderRadius: 14, paddingHorizontal: 17, color: "white", fontSize: 16 }, primary: { minHeight: 54, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87", marginTop: 5 }, primaryText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: .8 }, secondary: { minHeight: 52, alignItems: "center", justifyContent: "center" }, secondaryText: { color: "#69cfc7", fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  content: { paddingBottom: 30, gap: 12 }, card: { padding: 20, borderRadius: 20, backgroundColor: "#f7faf9", gap: 10 }, cardTitle: { color: "#0a3037", fontSize: 19, fontWeight: "800", marginBottom: 4 }, inputLight: { height: 54, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, paddingHorizontal: 15, color: "#0a3037", backgroundColor: "white" }, muted: { color: "#59716f", fontSize: 11 },
  bleDevice: { padding: 13, borderRadius: 12, borderWidth: 1, borderColor: "#cedbdc", backgroundColor: "white" }, bleDeviceSelected: { borderColor: "#0a8c87", borderWidth: 2 }, deviceNameDark: { color: "#0a3037", fontSize: 14, fontWeight: "800" },
  sectionLabel: { color: "#7d9a97", fontSize: 10, fontWeight: "900", letterSpacing: 1.2, marginTop: 14 }, telemetry: { padding: 17, borderRadius: 15, backgroundColor: "#134048" }, telemetryHeader: { flexDirection: "row", justifyContent: "space-between" }, deviceName: { color: "white", fontSize: 16, fontWeight: "700" }, time: { color: "#8eaaa7", fontSize: 10 }, topic: { color: "#69cfc7", fontSize: 10, marginTop: 5 }, payload: { color: "#d9efed", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", marginTop: 10 },
  empty: { color: "#829d9a", textAlign: "center", padding: 28 }, error: { color: "#ffc0af", textAlign: "center", fontSize: 12, paddingVertical: 12 },
});
