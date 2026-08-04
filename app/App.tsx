import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Account, Client, ID, Models, Query, TablesDB } from "react-native-appwrite";

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
  const [serial, setSerial] = useState("");
  const [name, setName] = useState("");
  const [credential, setCredential] = useState<Credential | null>(null);
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

  async function registerDevice() {
    setBusy(true); setError(""); setCredential(null);
    try {
      const device = await deviceApi<Device>("", "POST", { serial: serial.trim(), name: name.trim(), enabled: true });
      const mqtt = await deviceApi<Credential>(`/${encodeURIComponent(device.$id)}/credentials`, "POST", {});
      setCredential(mqtt); setSerial(""); setName("");
      await refresh();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }

  async function signOut() {
    await account.deleteSession({ sessionId: "current" });
    setUser(null); setDevices([]); setTelemetry([]); setCredential(null);
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
      <View style={styles.card}><Text style={styles.cardTitle}>Create Appwrite device</Text>
        <TextInput style={styles.inputLight} value={serial} onChangeText={(value) => setSerial(value.toUpperCase())} placeholder="AABBCCDDEEFF" autoCapitalize="characters" maxLength={12} />
        <Text style={styles.muted}>BLE name: PROV_{serial || "AABBCCDDEEFF"}</Text>
        <TextInput style={styles.inputLight} value={name} onChangeText={setName} placeholder="Display name" maxLength={128} />
        <Pressable style={styles.primary} onPress={registerDevice} disabled={busy || !/^[A-F0-9]{12}$/.test(serial) || !name.trim()}><Text style={styles.primaryText}>{busy ? "WORKING…" : "CREATE DEVICE + MQTT CREDENTIAL"}</Text></Pressable>
        {credential && <View style={styles.credential}><Text style={styles.credentialLabel}>COPY MQTT CREDENTIAL NOW</Text><Text style={styles.credentialValue}>clientId: {credential.clientId}</Text><Text style={styles.credentialValue}>username: {credential.username}</Text><Text style={styles.credentialValue}>password: {credential.password}</Text><Text style={styles.credentialHelp}>mqtts://mqtt.edgez.ai:8883</Text><Text style={styles.credentialHelp}>Publish: projects/{config.appwriteProjectId}/devices/{credential.username}/telemetry/&lt;channel&gt;</Text><Text style={styles.credentialHelp}>Subscribe: projects/{config.appwriteProjectId}/devices/{credential.username}/commands/#</Text></View>}
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
  credential: { padding: 16, borderRadius: 13, backgroundColor: "#092e35", marginTop: 8, gap: 6 }, credentialLabel: { color: "#70ddd4", fontSize: 9, fontWeight: "900", letterSpacing: 1.3 }, credentialValue: { color: "#d9efed", fontSize: 11 }, credentialHelp: { color: "#8eaaa7", fontSize: 10, marginTop: 5 },
  sectionLabel: { color: "#7d9a97", fontSize: 10, fontWeight: "900", letterSpacing: 1.2, marginTop: 14 }, telemetry: { padding: 17, borderRadius: 15, backgroundColor: "#134048" }, telemetryHeader: { flexDirection: "row", justifyContent: "space-between" }, deviceName: { color: "white", fontSize: 16, fontWeight: "700" }, time: { color: "#8eaaa7", fontSize: 10 }, topic: { color: "#69cfc7", fontSize: 10, marginTop: 5 }, payload: { color: "#d9efed", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", marginTop: 10 },
  empty: { color: "#829d9a", textAlign: "center", padding: 28 }, error: { color: "#ffc0af", textAlign: "center", fontSize: 12, paddingVertical: 12 },
});
