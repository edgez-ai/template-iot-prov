import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Account, Client, ID, Models, Query, TablesDB } from "react-native-appwrite";
import { ESPDevice, ESPProvisionManager, ESPSecurity, ESPTransport } from "@orbital-systems/react-native-esp-idf-provisioning";
import type { ESPWifiList } from "@orbital-systems/react-native-esp-idf-provisioning";

type Device = { $id: string; serial: string; name: string; status: string; enabled: boolean };
type Credential = { clientId: string; username: string; password: string };
type Telemetry = Models.Row & { deviceId: string; serial: string; channel: string; topic: string; payload: string; receivedAt: string };
type AppConfig = { appwriteEndpoint: string; appwriteProjectId: string; appwritePlatform: string; databaseId: string; telemetryTableId: string };

const appConfig = Constants.expoConfig?.extra as AppConfig | undefined;
if (!appConfig) throw new Error("Expo Appwrite configuration is missing");
const config: AppConfig = appConfig;
const endpoint = config.appwriteEndpoint.replace(/\/+$/, "");
const provisioningPop = "abcd1234";
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
    ? [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const checks = await Promise.all(permissions.map(async (permission) => ({
    permission,
    granted: await PermissionsAndroid.check(permission),
  })));
  const missing = checks.filter(({ granted }) => !granted).map(({ permission }) => permission);
  if (!missing.length) return;

  const results = await PermissionsAndroid.requestMultiple(missing);
  if (missing.some((permission) => results[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
    throw new Error("Bluetooth permission is required to discover and provision devices.");
  }
}

async function deviceApi<T>(path = "", method: "GET" | "POST" = "GET", body?: object) {
  const response = await fetch(`${endpoint}/devices${path}`, {
    method,
    credentials: "include",
    headers: { "content-type": "application/json", "x-appwrite-project": config.appwriteProjectId },
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
  const [proofOfPossession, setProofOfPossession] = useState(provisioningPop);
  const [bleConnected, setBleConnected] = useState(false);
  const [wifiNetworks, setWifiNetworks] = useState<ESPWifiList[]>([]);
  const [name, setName] = useState("");
  const [ssid, setSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [provisioningStatus, setProvisioningStatus] = useState("");
  const [provisioningDialogOpen, setProvisioningDialogOpen] = useState(false);
  const [provisioningStep, setProvisioningStep] = useState<1 | 2 | 3>(1);
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
    const timer = setInterval(() => {
      void refresh().catch((caught) => setError(messageOf(caught)));
    }, 5000);
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
      selectedBleDevice?.disconnect();
      setSelectedBleDevice(null); setProofOfPossession(provisioningPop); setBleConnected(false); setWifiNetworks([]); setSsid(""); setWifiPassword("");
      await requestBlePermissions();
      const found = await ESPProvisionManager.searchESPDevices("PROV_", ESPTransport.ble, ESPSecurity.secure);
      const valid = found.filter((device) => /^PROV_[A-F0-9]{12}$/i.test(device.name));
      setBleDevices(valid);
      setProvisioningStatus(valid.length ? "Select a device to provision." : "No provisioning devices found.");
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }

  function openProvisioningDialog() {
    selectedBleDevice?.disconnect();
    setBleDevices([]); setSelectedBleDevice(null); setProofOfPossession(provisioningPop); setBleConnected(false); setWifiNetworks([]); setName(""); setSsid(""); setWifiPassword("");
    setError(""); setProvisioningStatus("Start by scanning for a device in provisioning mode.");
    setProvisioningStep(1);
    setProvisioningDialogOpen(true);
  }

  function closeProvisioningDialog() {
    if (busy) return;
    selectedBleDevice?.disconnect();
    setSelectedBleDevice(null); setBleConnected(false); setWifiNetworks([]); setSsid(""); setWifiPassword("");
    setProvisioningDialogOpen(false);
  }

  function previousProvisioningStep() {
    if (provisioningStep === 3) {
      selectedBleDevice?.disconnect();
      setBleConnected(false); setWifiNetworks([]); setSsid(""); setWifiPassword("");
      setProvisioningStatus("Confirm the device details and PoP.");
      setProvisioningStep(2);
      return;
    }
    setSelectedBleDevice(null);
    setProvisioningStatus("Select a device to provision.");
    setProvisioningStep(1);
  }

  async function scanWifiNetworks(device: ESPDevice) {
    setProvisioningStatus("Asking the ESP32 to scan nearby Wi-Fi networks…");
    const found = await device.scanWifiList();
    const strongestBySsid = new Map<string, ESPWifiList>();
    for (const network of found) {
      const networkSsid = network.ssid.trim();
      if (!networkSsid) continue;
      const current = strongestBySsid.get(networkSsid);
      if (!current || network.rssi > current.rssi) {
        strongestBySsid.set(networkSsid, { ...network, ssid: networkSsid });
      }
    }
    const networks = [...strongestBySsid.values()].sort((left, right) => right.rssi - left.rssi);
    setWifiNetworks(networks);
    setProvisioningStatus(networks.length ? "Select the Wi-Fi network for this device." : "The ESP32 found no Wi-Fi networks.");
  }

  function selectBleDevice(device: ESPDevice) {
    selectedBleDevice?.disconnect();
    setError(""); setWifiNetworks([]); setSsid(""); setWifiPassword("");
    setSelectedBleDevice(device);
    setProofOfPossession(provisioningPop);
    setBleConnected(false);
    setProvisioningStatus(`Confirm the details for ${device.name}.`);
    setProvisioningStep(2);
  }

  async function connectAndScanWifi() {
    if (!selectedBleDevice || !proofOfPossession.trim()) return;
    setBusy(true); setError(""); setWifiNetworks([]); setSsid(""); setWifiPassword("");
    try {
      setProvisioningStatus(`Authenticating ${selectedBleDevice.name} with the provided PoP…`);
      await selectedBleDevice.connect(proofOfPossession.trim());
      setBleConnected(true);
      await scanWifiNetworks(selectedBleDevice);
      setProvisioningStep(3);
    } catch (caught) {
      selectedBleDevice.disconnect();
      setBleConnected(false);
      setWifiNetworks([]);
      setError(messageOf(caught));
      setProvisioningStatus("PoP authentication failed. Check the value shown on the OLED and try again.");
    } finally { setBusy(false); }
  }

  async function rescanWifiNetworks() {
    if (!selectedBleDevice || !bleConnected) return;
    setBusy(true); setError(""); setSsid(""); setWifiPassword("");
    try { await scanWifiNetworks(selectedBleDevice); }
    catch (caught) { setError(messageOf(caught)); setProvisioningStatus("Could not scan Wi-Fi networks."); }
    finally { setBusy(false); }
  }

  async function provisionDevice() {
    if (!selectedBleDevice || !bleConnected) return;
    setBusy(true); setError(""); setProvisioningStatus("Preparing the device credential…");
    try {
      const serial = serialFromBleName(selectedBleDevice.name);

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
      setSelectedBleDevice(null); setBleDevices([]); setProofOfPossession(provisioningPop); setBleConnected(false); setWifiNetworks([]); setName(""); setSsid(""); setWifiPassword("");
      setProvisioningDialogOpen(false);
      await refresh();
    } catch (caught) { setError(messageOf(caught)); setProvisioningStatus("Provisioning did not complete."); }
    finally { selectedBleDevice.disconnect(); setBleConnected(false); setWifiNetworks([]); setBusy(false); }
  }

  async function signOut() {
    selectedBleDevice?.disconnect();
    await account.deleteSession({ sessionId: "current" });
    setUser(null); setDevices([]); setTelemetry([]); setBleDevices([]); setSelectedBleDevice(null); setProofOfPossession(provisioningPop); setBleConnected(false); setWifiNetworks([]); setProvisioningDialogOpen(false);
  }

  const deviceNames = useMemo(() => new Map(devices.map((device) => [device.$id, device.name])), [devices]);
  if (busy && !user) return <SafeAreaProvider><SafeAreaView style={styles.safe}><ActivityIndicator style={styles.loader} color="#62d8cf" size="large" /></SafeAreaView></SafeAreaProvider>;

  return <SafeAreaProvider><SafeAreaView style={styles.safe}><StatusBar style="light" /><KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={styles.header}><View><Text style={styles.eyebrow}>APPWRITE DEVICES · MQTT</Text><Text style={styles.title}>{user ? "Device telemetry" : "Operator access"}</Text></View>{user && <Pressable onPress={signOut}><Text style={styles.signOut}>SIGN OUT</Text></Pressable>}</View>
    {!user ? <View style={styles.auth}>
      <Text style={styles.hero}>Devices in.{"\n"}<Text style={styles.accent}>Signals out.</Text></Text>
      <Text style={styles.authLabel}>EMAIL</Text>
      <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor="#718a83" autoCapitalize="none" keyboardType="email-address" />
      <Text style={styles.authLabel}>PASSWORD</Text>
      <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor="#718a83" secureTextEntry />
      <Pressable style={styles.primary} onPress={() => authenticate(false)} disabled={busy}><Text style={styles.primaryText}>SIGN IN</Text></Pressable>
      <Pressable style={styles.secondary} onPress={() => authenticate(true)} disabled={busy}><Text style={styles.secondaryText}>CREATE ACCOUNT</Text></Pressable>
    </View> : <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}><Text style={styles.cardTitle}>Provision device over BLE</Text>
        <Text style={styles.muted}>Add an ESP32 using the guided Bluetooth and Wi-Fi setup.</Text>
        <Pressable style={styles.primary} onPress={openProvisioningDialog} disabled={busy}><Text style={styles.primaryText}>PROVISION DEVICE</Text></Pressable>
      </View>
      <Text style={styles.sectionLabel}>{devices.length} DEVICES · {telemetry.length} RECENT MESSAGES</Text>
      {telemetry.map((row) => <View style={styles.telemetry} key={row.$id}><View style={styles.telemetryHeader}><Text style={styles.deviceName}>{deviceNames.get(row.deviceId) || row.serial}</Text><Text style={styles.time}>{new Date(row.receivedAt).toLocaleTimeString()}</Text></View><Text style={styles.topic}>{row.topic}</Text><Text style={styles.payload}>{JSON.stringify(JSON.parse(row.payload), null, 2)}</Text></View>)}
      {!telemetry.length && <Text style={styles.empty}>No MQTT telemetry yet.</Text>}
    </ScrollView>}
    <Modal visible={provisioningDialogOpen} transparent animationType="slide" onRequestClose={closeProvisioningDialog}>
      <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <View style={styles.dialogHeader}><View><Text style={styles.stepLabel}>STEP {provisioningStep} OF 3</Text><Text style={styles.dialogTitle}>{provisioningStep === 1 ? "Choose device" : provisioningStep === 2 ? "Device details" : "Connect Wi-Fi"}</Text></View><Pressable onPress={closeProvisioningDialog} disabled={busy}><Text style={styles.close}>CLOSE</Text></Pressable></View>
          <ScrollView contentContainerStyle={styles.dialogContent} keyboardShouldPersistTaps="handled">
            {provisioningStep === 1 && <>
              <Text style={styles.dialogHelp}>Put the ESP32 in provisioning mode, then scan for its PROV_ Bluetooth name.</Text>
              <Pressable style={styles.primary} onPress={scanBleDevices} disabled={busy}><Text style={styles.primaryText}>{busy ? "SCANNING…" : "SCAN FOR DEVICES"}</Text></Pressable>
              {bleDevices.map((device) => <Pressable key={device.name} style={styles.bleDevice} onPress={() => selectBleDevice(device)} disabled={busy}><Text style={styles.deviceNameDark}>{device.name}</Text><Text style={styles.muted}>Serial {device.name.slice(5).toUpperCase()}</Text></Pressable>)}
            </>}
            {provisioningStep === 2 && selectedBleDevice && <>
              <View style={styles.selectedSummary}><Text style={styles.deviceNameDark}>{selectedBleDevice.name}</Text><Text style={styles.muted}>Serial {selectedBleDevice.name.slice(5).toUpperCase()}</Text></View>
              <Text style={styles.fieldLabel}>NAME</Text>
              <TextInput style={styles.inputLight} value={name} onChangeText={setName} placeholder="Device name" maxLength={128} />
              <Text style={styles.fieldHint}>Optional. The serial is used when no name is entered.</Text>
              <Text style={styles.fieldLabel}>PROOF OF POSSESSION (PoP)</Text>
              <TextInput style={styles.inputLight} value={proofOfPossession} onChangeText={setProofOfPossession} placeholder="PoP shown on the device OLED" autoCapitalize="none" autoCorrect={false} />
              <Pressable style={styles.primary} onPress={connectAndScanWifi} disabled={busy || !proofOfPossession.trim()}><Text style={styles.primaryText}>{busy ? "CONNECTING…" : "CONNECT &amp; SCAN WI-FI"}</Text></Pressable>
            </>}
            {provisioningStep === 3 && selectedBleDevice && <>
              <View style={styles.wifiHeader}><Text style={styles.fieldLabel}>WI-FI NETWORK</Text><Pressable onPress={rescanWifiNetworks} disabled={busy}><Text style={styles.rescan}>RESCAN</Text></Pressable></View>
              {wifiNetworks.map((network) => <Pressable key={`${network.ssid}-${network.bssid || network.channel || "ap"}`} style={[styles.wifiNetwork, ssid === network.ssid && styles.wifiNetworkSelected]} onPress={() => { setSsid(network.ssid); setWifiPassword(""); }} disabled={busy}><View><Text style={styles.deviceNameDark}>{network.ssid}</Text><Text style={styles.muted}>{network.auth === 0 ? "Open network" : "Password required"}{network.channel ? ` · Channel ${network.channel}` : ""}</Text></View><Text style={styles.signal}>{network.rssi} dBm</Text></Pressable>)}
              {ssid && wifiNetworks.find((network) => network.ssid === ssid)?.auth !== 0 ? <><Text style={styles.fieldLabel}>WI-FI PASSWORD</Text><TextInput style={styles.inputLight} value={wifiPassword} onChangeText={setWifiPassword} placeholder={`Password for ${ssid}`} secureTextEntry /></> : null}
              <Pressable style={styles.primary} onPress={provisionDevice} disabled={busy || !ssid || (wifiNetworks.find((network) => network.ssid === ssid)?.auth !== 0 && !wifiPassword)}><Text style={styles.primaryText}>{busy ? "PROVISIONING…" : "PROVISION DEVICE"}</Text></Pressable>
            </>}
            {provisioningStep > 1 && <Pressable style={styles.backButton} onPress={previousProvisioningStep} disabled={busy}><Text style={styles.secondaryText}>BACK</Text></Pressable>}
            {provisioningStatus ? <Text style={styles.dialogStatus}>{provisioningStatus}</Text> : null}
            {error ? <Text style={styles.dialogError}>{error}</Text> : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </KeyboardAvoidingView></SafeAreaView></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#092e35" }, loader: { flex: 1 }, screen: { flex: 1, paddingHorizontal: 22, paddingTop: 18 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 20 }, eyebrow: { color: "#69cfc7", fontSize: 10, fontWeight: "900", letterSpacing: 1.4 }, title: { color: "#fff", fontSize: 28, fontWeight: "800", marginTop: 3 }, signOut: { color: "#90aaa7", fontSize: 10, fontWeight: "800" },
  auth: { flex: 1, justifyContent: "center", gap: 8, paddingBottom: 40 }, hero: { color: "white", fontSize: 45, lineHeight: 51, fontWeight: "900", letterSpacing: -1.8, marginBottom: 24 }, accent: { color: "#ff8264" }, authLabel: { color: "#90aaa7", fontSize: 9, fontWeight: "900", letterSpacing: 1, marginTop: 5 },
  input: { height: 58, borderWidth: 1, borderColor: "#36565b", borderRadius: 14, paddingHorizontal: 17, color: "white", fontSize: 16 }, primary: { minHeight: 54, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87", marginTop: 5 }, primaryText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: .8 }, secondary: { minHeight: 52, alignItems: "center", justifyContent: "center" }, secondaryText: { color: "#69cfc7", fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  content: { paddingBottom: 30, gap: 12 }, card: { padding: 20, borderRadius: 20, backgroundColor: "#f7faf9", gap: 10 }, cardTitle: { color: "#0a3037", fontSize: 19, fontWeight: "800", marginBottom: 4 }, inputLight: { height: 54, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, paddingHorizontal: 15, color: "#0a3037", backgroundColor: "white" }, muted: { color: "#59716f", fontSize: 11 },
  bleDevice: { padding: 13, borderRadius: 12, borderWidth: 1, borderColor: "#cedbdc", backgroundColor: "white" }, bleDeviceSelected: { borderColor: "#0a8c87", borderWidth: 2 }, deviceNameDark: { color: "#0a3037", fontSize: 14, fontWeight: "800" },
  wifiHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }, wifiTitle: { color: "#59716f", fontSize: 9, fontWeight: "900", letterSpacing: .8 }, rescan: { color: "#0a8c87", fontSize: 10, fontWeight: "900" }, wifiNetwork: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "#cedbdc", backgroundColor: "white", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, wifiNetworkSelected: { borderColor: "#0a8c87", borderWidth: 2, backgroundColor: "#e9f7f5" }, signal: { color: "#59716f", fontSize: 10, fontWeight: "700" },
  modalOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(3, 24, 29, .72)" }, dialog: { maxHeight: "90%", borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: "#f7faf9", paddingTop: 20 }, dialogHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 22, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: "#dce6e5" }, stepLabel: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 1 }, dialogTitle: { color: "#0a3037", fontSize: 24, fontWeight: "900", marginTop: 3 }, close: { color: "#59716f", fontSize: 10, fontWeight: "900" }, dialogContent: { padding: 22, paddingBottom: 34, gap: 10 }, dialogHelp: { color: "#59716f", fontSize: 13, lineHeight: 19 }, selectedSummary: { padding: 13, borderRadius: 12, backgroundColor: "#e9f7f5", marginBottom: 4 }, fieldLabel: { color: "#385753", fontSize: 9, fontWeight: "900", letterSpacing: .9, marginTop: 5 }, fieldHint: { color: "#718783", fontSize: 10, marginTop: -5 }, backButton: { minHeight: 44, alignItems: "center", justifyContent: "center" }, dialogStatus: { color: "#59716f", fontSize: 11, textAlign: "center", marginTop: 2 }, dialogError: { color: "#b9472f", fontSize: 11, textAlign: "center" },
  sectionLabel: { color: "#7d9a97", fontSize: 10, fontWeight: "900", letterSpacing: 1.2, marginTop: 14 }, telemetry: { padding: 17, borderRadius: 15, backgroundColor: "#134048" }, telemetryHeader: { flexDirection: "row", justifyContent: "space-between" }, deviceName: { color: "white", fontSize: 16, fontWeight: "700" }, time: { color: "#8eaaa7", fontSize: 10 }, topic: { color: "#69cfc7", fontSize: 10, marginTop: 5 }, payload: { color: "#d9efed", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", marginTop: 10 },
  empty: { color: "#829d9a", textAlign: "center", padding: 28 }, error: { color: "#ffc0af", textAlign: "center", fontSize: 12, paddingVertical: 12 },
});
