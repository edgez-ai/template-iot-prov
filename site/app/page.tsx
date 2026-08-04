"use client";

import { Account, Client, ID, Models, Query, TablesDB } from "appwrite";
import { useCallback, useEffect, useMemo, useState } from "react";

type Device = { $id: string; serial: string; name: string; status: string; enabled: boolean };
type Telemetry = Models.Row & { deviceId: string; serial: string; channel: string; topic: string; payload: string; receivedAt: string };

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!);
const account = new Account(client);
const tables = new TablesDB(client);
const databaseId = process.env.NEXT_PUBLIC_DATABASE_ID!;
const telemetryTableId = process.env.NEXT_PUBLIC_TELEMETRY_TABLE_ID!;
const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!.replace(/\/+$/, "");
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function listDevices<T>() {
  const jwt = await account.createJWT();
  const response = await fetch(`${endpoint}/devices`, {
    headers: {
      "content-type": "application/json",
      "x-appwrite-project": projectId,
      "x-appwrite-jwt": jwt.jwt,
    },
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || "Appwrite Devices request failed.");
  return payload;
}

export default function Home() {
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [deviceResult, telemetryRows] = await Promise.all([
      listDevices<{ devices: Device[] }>(),
      tables.listRows({ databaseId, tableId: telemetryTableId, queries: [Query.orderDesc("receivedAt"), Query.limit(50)] }),
    ]);
    setDevices(deviceResult.devices);
    setTelemetry(telemetryRows.rows as unknown as Telemetry[]);
  }, []);

  useEffect(() => {
    account.get().then(async (current) => { setUser(current); await refresh(); })
      .catch(() => undefined).finally(() => setBusy(false));
  }, [refresh]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh, user]);

  async function authenticate(register: boolean) {
    setBusy(true); setError("");
    try {
      if (register) await account.create({ userId: ID.unique(), email, password });
      await account.createEmailPasswordSession({ email, password });
      setUser(await account.get());
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  async function signOut() {
    await account.deleteSession({ sessionId: "current" });
    setUser(null); setDevices([]); setTelemetry([]);
  }

  const deviceNames = useMemo(() => new Map(devices.map((device) => [device.$id, device.name])), [devices]);

  return <main className="shell">
    <header className="topbar"><span className="mark">P</span><strong>IoT Provisioning</strong>{user && <button className="link" onClick={signOut}>Sign out</button>}</header>
    {!user ? <section className="auth-grid">
      <div><p className="eyebrow">NEXT.JS · APPWRITE AUTH · MQTT</p><h1>Devices in.<br /><em>Signals out.</em></h1><p className="lede">Sign in to read your permitted device and telemetry rows directly from Appwrite.</p></div>
      <form className="panel" onSubmit={(event) => { event.preventDefault(); void authenticate(false); }}>
        <h2>Operator access</h2>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></label>
        <div className="actions"><button disabled={busy}>Sign in</button><button className="secondary" type="button" disabled={busy} onClick={() => authenticate(true)}>Create account</button></div>
      </form>
    </section> : <section className="dashboard">
      <div className="heading-row"><div><p className="eyebrow">SIGNED IN AS {user.email}</p><h1>Device telemetry</h1></div><span className="count">DIRECT TABLESDB READS</span></div>
      <div className="columns">
        <aside className="panel"><h2>Provisioned devices</h2><p>New devices can only be onboarded from the mobile app over BLE.</p>{devices.map((device) => <p key={device.$id}><strong>{device.name}</strong><br /><code>{device.serial}</code></p>)}{!devices.length && <p>No devices provisioned yet.</p>}</aside>
        <div className="stream">
          {telemetry.map((row) => <article key={row.$id}><header><strong>{deviceNames.get(row.deviceId) || row.serial}</strong><time>{new Date(row.receivedAt).toLocaleString()}</time></header><code>{row.topic}</code><pre>{JSON.stringify(JSON.parse(row.payload), null, 2)}</pre></article>)}
          {!telemetry.length && <p className="empty">No MQTT telemetry received yet.</p>}
        </div>
      </div>
    </section>}
    {error && <p className="error" role="alert">{error}</p>}
  </main>;
}
