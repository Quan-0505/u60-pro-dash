import { useEffect, useMemo, useState } from "react";
import { Download, FileUp, RefreshCw, Save, Trash2 } from "lucide-react";
import { api, type ObjectData } from "./api";
import type { Route } from "./catalog";
import { useSession } from "./live";
import { useMutation } from "./mutations";
import {
  Definition,
  Empty,
  ErrorState,
  Field,
  Note,
  Panel,
  PanelTitle,
  Refresh,
  Stats,
  Toggle,
} from "./ui";
import { t } from "./i18n";
import "./extensions.css";

const extensionApi = "/api/u60/extensions/";

export function ExtensionsPage({ route }: { route: Route }) {
  switch (route.tab) {
    case "power":
      return <HybridPower />;
    case "plugins":
      return <PluginManager />;
    case "catalog":
      return <PluginCatalog />;
    default:
      return <CpuMode />;
  }
}

type CpuPolicy = {
  policy: string;
  governor: string;
  frequency_khz: string;
  available: string;
  min_khz: string;
  max_khz: string;
};
type CpuState = {
  mode: string;
  autostart: boolean;
  policies: CpuPolicy[];
  cores: { name: string; frequency_khz: string; governor: string }[];
};
const cpuModes: [string, string][] = [
  ["powersave", "Power saving"],
  ["balance", "Balanced"],
  ["performance", "Performance"],
  ["restore", "Restore system defaults"],
];

function CpuMode() {
  const mutation = useMutation();
  const [data, setData] = useState<CpuState | null>(null);
  const [mode, setMode] = useState("balance");
  const [autostart, setAutostart] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const [message, setMessage] = useState("");

  async function reload() {
    setLoading(true);
    setError(undefined);
    try {
      const next = await api<CpuState>(extensionApi + "cpu");
      setData(next);
      setMode(next.mode || "balance");
      setAutostart(!!next.autostart);
      setMessage("");
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  const supported = (selected: string) => {
    if (selected === "restore") return true;
    const policies = data?.policies || [];
    if (!policies.length) return false;
    const governor = selected === "balance" ? "schedutil" : selected;
    return policies.every((p) => {
      const choices = p.available.split(/\s+/).filter(Boolean);
      return choices.includes(governor) ||
        (selected === "balance" && choices.includes("performance"));
    });
  };
  const changed = !!data && (mode !== data.mode || autostart !== data.autostart);

  async function apply() {
    if (!data || !changed || !supported(mode) || mutation.busy) return;
    const restoring = mode === "restore";
    const confirmed = await mutation.confirm({
      title: restoring ? "Restore CPU defaults?" : "Apply CPU mode?",
      message: restoring
        ? "This resets each CPU policy to its hardware min/max range. The selected startup restore setting will also be saved."
        : "This changes CPU governor behavior and can affect heat, power use and response. Device thermal protection remains active.",
    });
    if (!confirmed) return;
    setSaving(true);
    setError(undefined);
    setMessage("");
    try {
      const result = await mutation.run(() =>
        api<CpuState>(extensionApi + "cpu", {
          method: "PUT",
          body: { mode, autostart },
          timeout: 30000,
        }),
      );
      setData(result);
      setMode(result.mode || mode);
      setAutostart(!!result.autostart);
      if (result.mode !== mode || !!result.autostart !== autostart)
        throw new Error("The router did not confirm the requested CPU mode.");
      setMessage("Applied and verified");
    } catch (e) {
      setError(e as Error);
      try {
        const actual = await api<CpuState>(extensionApi + "cpu");
        setData(actual);
        setMode(actual.mode || "balance");
        setAutostart(!!actual.autostart);
      } catch {
        // Keep the original operation error visible when status is also unavailable.
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Panel>
        <PanelTitle
          title="CPU mode and startup restore"
          note="Uses the device CPU policies and reads back the applied governor and frequencies."
          action={<Refresh onClick={() => void reload()} disabled={loading || saving} />}
        />
        <ErrorState error={error} retry={() => void reload()} />
        {!data ? (
          <p className="loading-state">{loading ? t("Loading…") : t("Settings unavailable")}</p>
        ) : (
          <>
            <div className="form-grid extension-form-grid">
              <Field label="CPU mode" hint="Balanced uses schedutil where available and falls back to performance when required by the device.">
                <select
                  value={mode}
                  disabled={mutation.busy || saving}
                  onChange={(event) => {
                    setMode(event.target.value);
                    setMessage("");
                  }}
                >
                  {cpuModes.map(([value, label]) => (
                    <option key={value} value={value} disabled={!supported(value)}>
                      {t(label)}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="extension-toggle">
                <div>
                  <strong>{t("Restore this mode at startup")}</strong>
                  <small>{t("Reapply the selected CPU mode when the router starts.")}</small>
                </div>
                <Toggle
                  label="Restore this mode at startup"
                  on={autostart}
                  disabled={mutation.busy || saving}
                  onChange={() => {
                    setAutostart((value) => !value);
                    setMessage("");
                  }}
                />
              </div>
            </div>
            <div className="extension-actions">
              <button className="btn primary" onClick={() => void apply()} disabled={!changed || mutation.busy || saving || !supported(mode)}>
                <Save size={15} /> {t(saving ? "Applying…" : "Apply CPU mode")}
              </button>
              <span role="status">{t(message || (changed ? "Changes are not applied yet." : "Current settings are applied."))}</span>
            </div>
            <Note warning={mode === "restore"}>
              {mode === "restore"
                ? t("Restore resets frequency limits to the hardware range. Temperature protection is still managed by the device.")
                : t("The device thermal controller remains active. CPU mode changes are coordinated with the upstream performance profiles.")}
            </Note>
          </>
        )}
      </Panel>
      <Panel>
        <PanelTitle title="Actual CPU status" note="Live governor and frequency values read from each CPU policy." />
        {data ? (
          <>
            <Stats items={[["Saved mode", t(cpuModes.find(([value]) => value === data.mode)?.[1] || data.mode)], ["Startup restore", data.autostart ? t("Enabled") : t("Disabled")], ["CPU policies", data.policies.length]]} />
            {data.policies.length ? (
              <div className="extension-table-wrap">
                <table className="extension-table">
                  <thead><tr><th>{t("Policy")}</th><th>{t("Governor")}</th><th>{t("Current frequency")}</th><th>{t("Min / max")}</th></tr></thead>
                  <tbody>{data.policies.map((policy) => (
                    <tr key={policy.policy}>
                      <td>{policy.policy}</td>
                      <td>{policy.governor || "—"}</td>
                      <td>{formatKhz(policy.frequency_khz)}</td>
                      <td>{formatKhz(policy.min_khz)} / {formatKhz(policy.max_khz)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <Empty>{t("No CPU frequency policies were reported by this device.")}</Empty>}
          </>
        ) : <ErrorState error={error} retry={() => void reload()} />}
      </Panel>
    </>
  );
}

function formatKhz(value: string | number | undefined) {
  const khz = Number(value);
  return Number.isFinite(khz) && khz > 0 ? `${(khz / 1000).toFixed(0)} MHz` : "—";
}

type PowerSettings = {
  bypass_power: boolean;
  auto_bypass: boolean;
  charge_limit: boolean;
  charge_val: number;
  charge_recover: number;
  charge_cur: number | null;
};
type PowerState = PowerSettings & {
  monitor_running?: boolean;
  input_online?: string;
  adsp_state?: string;
  restrict_chg?: string;
  restrict_cur?: string;
  battery_current_ua?: string;
  battery_temp?: string;
};
const defaultPower: PowerSettings = {
  bypass_power: false,
  auto_bypass: false,
  charge_limit: true,
  charge_val: 70,
  charge_recover: 2,
  charge_cur: null,
};
function powerConfig(value: ObjectData): PowerSettings {
  return {
    bypass_power: value.bypass_power === true,
    auto_bypass: value.auto_bypass === true,
    charge_limit: value.charge_limit === true,
    charge_val: Number(value.charge_val ?? defaultPower.charge_val),
    charge_recover: Number(value.charge_recover ?? defaultPower.charge_recover),
    charge_cur: value.charge_cur == null || value.charge_cur === "" ? null : Number(value.charge_cur),
  };
}
function HybridPower() {
  const mutation = useMutation();
  const [data, setData] = useState<PowerState | null>(null);
  const [draft, setDraft] = useState<PowerSettings>(defaultPower);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const [message, setMessage] = useState("");

  async function reload() {
    setLoading(true);
    setError(undefined);
    try {
      const next = await api<PowerState>(extensionApi + "battery");
      setData(next);
      setDraft(powerConfig(next));
      setMessage("");
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  const update = (key: keyof PowerSettings, value: boolean | number | null) => {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === "bypass_power" && value === true) next.auto_bypass = false;
      if (key === "auto_bypass" && value === true) next.bypass_power = false;
      return next;
    });
    setMessage("");
  };
  const changed = !!data && Object.keys(defaultPower).some((key) =>
    draft[key as keyof PowerSettings] !== powerConfig(data)[key as keyof PowerSettings],
  );

  async function apply() {
    if (!data || !changed || mutation.busy) return;
    if (!Number.isInteger(draft.charge_val) || draft.charge_val < 10 || draft.charge_val > 100) {
      setError(new Error("Charge stop level must be from 10 to 100 percent."));
      return;
    }
    if (!Number.isInteger(draft.charge_recover) || draft.charge_recover < 1 || draft.charge_recover > 20) {
      setError(new Error("Charge recovery gap must be from 1 to 20 percent."));
      return;
    }
    if (draft.charge_cur !== null && (!Number.isInteger(draft.charge_cur) || draft.charge_cur < 500 || draft.charge_cur > 5000)) {
      setError(new Error("Current limit must be blank or from 500 to 5000 mA."));
      return;
    }
    const confirmed = await mutation.confirm({
      title: "Save hybrid direct power settings?",
      message: "The resident battery monitor owns charging and hybrid direct power. It decides when direct power can remain active based on input, load and temperature; this setting does not bypass those protections.",
    });
    if (!confirmed) return;
    setSaving(true);
    setError(undefined);
    setMessage("");
    try {
      const result = await mutation.run(() =>
        api<PowerState>(extensionApi + "battery", {
          method: "PUT",
          body: draft,
          timeout: 30000,
        }),
      );
      const actual = powerConfig(result);
      if (Object.keys(defaultPower).some((key) => actual[key as keyof PowerSettings] !== draft[key as keyof PowerSettings]))
        throw new Error("The router did not confirm all saved power settings.");
      setData(result);
      setDraft(actual);
      setMessage("Applied and verified");
    } catch (e) {
      setError(e as Error);
      try {
        const actual = await api<PowerState>(extensionApi + "battery");
        setData(actual);
        setDraft(powerConfig(actual));
      } catch {
        // Keep the original operation error visible when status is also unavailable.
      }
    } finally {
      setSaving(false);
    }
  }

  const temperature = Number(data?.battery_temp);
  return (
    <>
      <Panel>
        <PanelTitle title="Hybrid direct power and charging" note="Edits the existing resident battery monitor configuration shared with the legacy console." action={<Refresh onClick={() => void reload()} disabled={loading || saving} />} />
        <ErrorState error={error} retry={() => void reload()} />
        {!data ? (
          <p className="loading-state">{loading ? t("Loading…") : t("Settings unavailable")}</p>
        ) : (
          <>
            <div className="extension-toggle-list">
              <SettingToggle title="Manual hybrid direct power" description="Request direct supply when external power is connected; the monitor may leave direct mode under high load." value={draft.bypass_power} onChange={(value) => update("bypass_power", value)} disabled={mutation.busy || saving} />
              <SettingToggle title="Automatic hybrid direct power" description="Let the resident monitor enter or leave direct supply according to its current rules." value={draft.auto_bypass} onChange={(value) => update("auto_bypass", value)} disabled={mutation.busy || saving} />
              <SettingToggle title="Charge limit protection" description="Stop charging at the configured level and resume after the recovery gap." value={draft.charge_limit} onChange={(value) => update("charge_limit", value)} disabled={mutation.busy || saving} />
            </div>
            <div className="form-grid extension-form-grid extension-numeric-grid">
              <Field label="Stop charging at (%)"><input type="number" min={10} max={100} step={1} value={draft.charge_val} disabled={mutation.busy || saving} onChange={(e) => update("charge_val", Number(e.target.value))} /></Field>
              <Field label="Resume gap (%)"><input type="number" min={1} max={20} step={1} value={draft.charge_recover} disabled={mutation.busy || saving} onChange={(e) => update("charge_recover", Number(e.target.value))} /></Field>
              <Field label="Charge current limit (mA)" hint="Leave blank to restore the stock current limit."><input type="number" min={500} max={5000} step={100} placeholder="Stock limit" value={draft.charge_cur ?? ""} disabled={mutation.busy || saving} onChange={(e) => update("charge_cur", e.target.value === "" ? null : Number(e.target.value))} /></Field>
            </div>
            <div className="extension-actions">
              <button className="btn primary" onClick={() => void apply()} disabled={!changed || mutation.busy || saving}><Save size={15} /> {t(saving ? "Saving…" : "Save power settings")}</button>
              <span role="status">{t(message || (changed ? "Changes are not applied yet." : "Current settings are applied."))}</span>
            </div>
            <Note warning>{t("Manual and automatic direct power are mutually exclusive. Actual charging and supply behavior remains controlled by the resident battery monitor.")}</Note>
          </>
        )}
      </Panel>
      <Panel>
        <PanelTitle title="Battery controller status" note="Configuration and observed device state are shown separately." />
        {data ? (
          <>
            <Stats items={[["Monitor", data.monitor_running ? t("Running") : t("Not confirmed")], ["USB input", data.input_online === "1" ? t("Online") : t("Offline")], ["Battery temperature", Number.isFinite(temperature) && temperature !== 0 ? `${(temperature / 10).toFixed(1)} °C` : "—"], ["Battery current", formatMicroamps(data.battery_current_ua)]]} />
            <Definition items={[["Manual direct power request", data.bypass_power ? t("On") : t("Off")], ["Automatic direct power", data.auto_bypass ? t("On") : t("Off")], ["Charge limit", data.charge_limit ? `${data.charge_val}% / ${data.charge_recover}% gap` : t("Off")], ["Charger state", data.adsp_state || "—"], ["Charge restriction", data.restrict_chg || "—"], ["Current restriction", data.restrict_cur || "—"]]} />
          </>
        ) : <ErrorState error={error} retry={() => void reload()} />}
      </Panel>
    </>
  );
}

function SettingToggle({ title, description, value, onChange, disabled }: { title: string; description: string; value: boolean; onChange: (value: boolean) => void; disabled: boolean }) {
  return (
    <div className="extension-toggle">
      <div><strong>{t(title)}</strong><small>{t(description)}</small></div>
      <Toggle label={title} on={value} disabled={disabled} onChange={() => onChange(!value)} />
    </div>
  );
}
function formatMicroamps(value: string | undefined) {
  const current = Number(value);
  return Number.isFinite(current) && value ? `${(current / 1000).toFixed(0)} mA` : "—";
}

type PluginDraft = { baseline: string | null; source: string; message: string; error: string };
const emptyPluginDraft: PluginDraft = { baseline: null, source: "", message: "", error: "" };
let sharedPluginDraft: PluginDraft = { ...emptyPluginDraft };
let sharedPluginEpoch: number | null = null;
function PluginManager() {
  const session = useSession();
  const mutation = useMutation();
  if (sharedPluginEpoch !== session.epoch) {
    sharedPluginEpoch = session.epoch;
    sharedPluginDraft = { ...emptyPluginDraft };
  }
  const [draft, setDraft] = useState<PluginDraft>(() => ({ ...sharedPluginDraft }));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const loaded = draft.baseline !== null;
  const dirty = loaded && draft.source !== draft.baseline;

  function update(change: (previous: PluginDraft) => PluginDraft) {
    setDraft((previous) => {
      const next = change(previous);
      sharedPluginDraft = next;
      return next;
    });
  }
  async function readCurrent(discard = false) {
    if (dirty && !discard) {
      const confirmed = await mutation.confirm({ title: "Discard plugin draft?", message: "This reload replaces the editor with the current plugin source on the router." });
      if (!confirmed) return;
    }
    setLoading(true);
    setNotice("");
    update((previous) => ({ ...previous, error: "" }));
    try {
      const value = await api<{ source: string }>(extensionApi + "plugins");
      update(() => ({ baseline: value.source, source: value.source, message: "Current plugin source loaded.", error: "" }));
    } catch (e) {
      update((previous) => ({ ...previous, error: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!loaded) void readCurrent(true);
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    if (!loaded || !dirty || mutation.busy) return;
    if (new TextEncoder().encode(draft.source).length > 2 * 1024 * 1024) {
      update((previous) => ({ ...previous, error: "Plugin source exceeds the 2 MiB device limit." }));
      return;
    }
    const confirmed = await mutation.confirm({
      title: "Save plugin source?",
      message: "Plugin HTML and scripts can execute commands through the management page. Save only code you trust. This source is shared with the 2333 backup console.",
      danger: true,
    });
    if (!confirmed) return;
    setSaving(true);
    setNotice("");
    update((previous) => ({ ...previous, error: "" }));
    try {
      const result = await mutation.run(() =>
        api<{ source: string }>(extensionApi + "plugins", {
          method: "PUT",
          body: { source: draft.source, previous_source: draft.baseline },
          timeout: 30000,
        }),
      );
      update(() => ({ baseline: result.source, source: result.source, message: "Saved and read back from the router.", error: "" }));
    } catch (e) {
      update((previous) => ({ ...previous, error: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function importFile(file?: File) {
    if (!file) return;
    if (!loaded) {
      update((previous) => ({ ...previous, error: "Read the current plugin source before importing a file." }));
      return;
    }
    if (file.size > 1024 * 1024) {
      update((previous) => ({ ...previous, error: "A single plugin file must be no larger than 1 MiB." }));
      return;
    }
    const text = await file.text();
    const next = `${draft.source}${draft.source && !draft.source.endsWith("\n") ? "\n" : ""}${text}\n`;
    if (new TextEncoder().encode(next).length > 2 * 1024 * 1024) {
      update((previous) => ({ ...previous, error: "This import would exceed the 2 MiB device limit." }));
      return;
    }
    update((previous) => ({ ...previous, source: next, error: "", message: "Imported to an unsaved draft." }));
  }

  const blocks = useMemo(() => {
    const found: { name: string; text: string; start: number; end: number }[] = [];
    const pattern = /<!--\s*\[KANO_PLUGIN_START\]\s*([^\n]*?)\s*-->[\s\S]*?<!--\s*\[KANO_PLUGIN_END\][^\n]*?-->/g;
    for (const match of draft.source.matchAll(pattern)) {
      const start = match.index ?? 0;
      found.push({ name: match[1].trim() || "Unnamed plugin", text: match[0], start, end: start + match[0].length });
    }
    return found;
  }, [draft.source]);

  function removeBlock(block: (typeof blocks)[number]) {
    update((previous) => ({ ...previous, source: previous.source.slice(0, block.start) + previous.source.slice(block.end), error: "", message: `Removed ${block.name} from the draft. Save to apply it.` }));
  }
  function downloadSource() {
    const url = URL.createObjectURL(new Blob([draft.source], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "u60-plugins.html";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <>
      <Panel>
        <PanelTitle title="Installed plugin extensions" note="Manage the extension HTML shared with the legacy console." action={<button className="btn small" onClick={() => void readCurrent()} disabled={loading || saving}><RefreshCw size={14} /> {t("Read current source")}</button>} />
        <Note warning>{t("Plugin code is executable and may affect the whole management page. The 27-item store catalog below is informational only; it does not install or run catalog plugins.")}</Note>
        <ErrorState error={draft.error ? new Error(draft.error) : undefined} />
        {loaded && (
          <>
            <div className="extension-plugin-inventory">
              <div className="extension-inventory-heading"><strong>{t("Recognized installed plugin blocks")}</strong><span>{blocks.length}</span></div>
              {blocks.length ? blocks.map((block) => (
                <div className="extension-plugin-row" key={`${block.start}:${block.name}`}>
                  <span>{block.name}</span>
                  <button className="btn small" onClick={() => removeBlock(block)} disabled={saving || mutation.busy}><Trash2 size={14} /> {t("Remove to draft")}</button>
                </div>
              )) : <p className="extension-subtle">{t("No complete marked plugin blocks were found in the current source.")}</p>}
            </div>
            <Field label="Plugin source code" hint={`${new TextEncoder().encode(draft.source).length.toLocaleString()} / 2,097,152 bytes`}>
              <textarea className="extension-code" rows={22} spellCheck={false} value={draft.source} disabled={loading || saving} onChange={(event) => update((previous) => ({ ...previous, source: event.target.value, error: "", message: "Unsaved draft." }))} />
            </Field>
            <div className="extension-actions extension-plugin-actions">
              <label className="btn"><FileUp size={15} /> {t("Import plugin file to draft")}<input type="file" hidden accept=".html,.htm,.js,.txt,*/*" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
              <button className="btn" onClick={downloadSource} disabled={!loaded}><Download size={15} /> {t("Export source")}</button>
              <button className="btn primary" onClick={() => void save()} disabled={!dirty || saving || mutation.busy}><Save size={15} /> {t(saving ? "Saving…" : "Save plugin changes")}</button>
              <span role="status">{t(notice || draft.message || (dirty ? "Unsaved changes." : "Source matches the router."))}</span>
            </div>
          </>
        )}
        {!loaded && <div className="loading-state">{loading ? t("Loading current plugin source…") : <button className="btn" onClick={() => void readCurrent(true)}>{t("Load installed plugins")}</button>}</div>}
      </Panel>
    </>
  );
}

type CatalogItem = {
  id: string;
  name: string;
  version: string;
  author: string;
  compatibility: string;
  description: string;
  updatedAt: string;
  downloads: number;
  category: string;
};
type CatalogData = {
  title: string;
  source: string;
  scope: string;
  observedOn: string;
  snapshot: boolean;
  count: number;
  plugins: CatalogItem[];
};
function PluginCatalog() {
  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("original");

  async function reload() {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/console/a/plugin-catalog.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json() as CatalogData;
      if (!Array.isArray(value.plugins) || value.count !== value.plugins.length || new Set(value.plugins.map((plugin) => plugin.id)).size !== value.count)
        throw new Error("Plugin catalog count or IDs did not validate.");
      setCatalog(value);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  const categories = useMemo(() => [...new Set(catalog?.plugins.map((plugin) => plugin.category) || [])].sort((a, b) => a.localeCompare(b, "zh-CN")), [catalog]);
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const result = (catalog?.plugins || []).filter((plugin) =>
      (!category || plugin.category === category) &&
      [plugin.name, plugin.author, plugin.description, plugin.compatibility, plugin.category].join(" ").toLocaleLowerCase().includes(term),
    );
    if (sort === "name") result.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    if (sort === "date") result.sort((a, b) => Date.parse(b.updatedAt.replaceAll("/", "-")) - Date.parse(a.updatedAt.replaceAll("/", "-")));
    return result;
  }, [catalog, category, query, sort]);

  function download(name: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCsv() {
    if (!catalog) return;
    const cell = (value: unknown) => `"${String(value ?? "").replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
    const rows: unknown[][] = [["Name", "Version", "Author", "Category", "Compatibility", "Description", "Store update", "Downloads"], ...catalog.plugins.map((plugin) => [plugin.name, plugin.version, plugin.author, plugin.category, plugin.compatibility, plugin.description, plugin.updatedAt, plugin.downloads])];
    download("U60-plugin-catalog.csv", "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  }

  return (
    <Panel>
      <PanelTitle title="Read-only plugin store catalog" note="Browse the store snapshot to plan later interface adaptations." action={<Refresh onClick={() => void reload()} disabled={loading} />} />
      <Note>{t("This page only reads and exports the catalog. It has no install, update or execute action for store plugins.")}</Note>
      <ErrorState error={error} retry={() => void reload()} />
      {catalog && (
        <>
          <div className="extension-catalog-toolbar">
            <Field label="Search name, author, function or model"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></Field>
            <Field label="Category"><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">{t("All categories")}</option>{categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
            <Field label="Sort"><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="original">{t("Store order")}</option><option value="date">{t("Latest update")}</option><option value="name">{t("Name")}</option></select></Field>
          </div>
          <div className="extension-catalog-summary"><strong>{t("Showing {0} of {1} plugins", visible.length, catalog.count)}</strong><span>{t("Snapshot date: {0}", catalog.observedOn)} · {t(catalog.scope)}</span></div>
          <div className="extension-catalog-grid">
            {visible.map((plugin) => (
              <article className="extension-catalog-card" key={plugin.id}>
                <div className="extension-catalog-card-heading"><span className="extension-category">{plugin.category}</span><span className="extension-catalog-id">{plugin.id}</span></div>
                <h3>{plugin.name}</h3>
                <p className="extension-catalog-version">{plugin.version} · {t("by {0}", plugin.author)}</p>
                <p className="extension-catalog-compat">{plugin.compatibility}</p>
                <p className="extension-catalog-description">{plugin.description || t("The original store did not provide a description.")}</p>
                <footer>{t("Updated {0}", plugin.updatedAt)} · {t("{0} downloads", plugin.downloads.toLocaleString())}</footer>
              </article>
            ))}
          </div>
          {!visible.length && <Empty>{t("No plugins match the current filters.")}</Empty>}
          <div className="extension-actions">
            <button className="btn" onClick={() => { setQuery(""); setCategory(""); setSort("original"); }}>{t("Clear filters")}</button>
            <button className="btn" onClick={() => download("U60-plugin-catalog.json", JSON.stringify(catalog, null, 2), "application/json;charset=utf-8")}><Download size={15} /> {t("Export catalog JSON")}</button>
            <button className="btn" onClick={exportCsv}><Download size={15} /> {t("Export plugin list CSV")}</button>
          </div>
          <p className="extension-subtle">{t("This is a snapshot of the catalog visible from the 2333 store at the recorded date. Descriptions and compatibility text are store-provided; compatibility has not been validated plugin by plugin.")}</p>
        </>
      )}
      {!catalog && loading && <p className="loading-state">{t("Loading catalog…")}</p>}
    </Panel>
  );
}
