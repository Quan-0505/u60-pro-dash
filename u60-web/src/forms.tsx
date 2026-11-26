import { useEffect, useRef, useState } from "react";
import { ApiError, api, type ObjectData } from "./api";
import { useResource, useSession } from "./live";
import { useMutation } from "./mutations";
import {
  AutoFeedback,
  ErrorState,
  Field,
  Panel,
  PanelTitle,
  Password,
  Refresh,
  scalar,
} from "./ui";
import { t } from "./i18n";
export type Option = [string, string];
export type FormField = {
  key: string;
  label: string;
  readKey?: string;
  type?: "text" | "password" | "number" | "textarea" | "url";
  options?: Option[];
  optionsFor?: (current: ObjectData) => Option[];
  wire?: "number" | "boolean";
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  hint?: string;
  allowMissing?: boolean;
};
export type FormSpec = {
  id: string;
  title: string;
  note?: string;
  read: string;
  readMethod?: string;
  readBody?: unknown;
  write?: string;
  asyncWrite?: string;
  asyncStatus?: string;
  scope?: string;
  method?: string;
  fields: FormField[];
  decode?: (data: ObjectData) => ObjectData;
  body?: (
    changed: ObjectData,
    all: ObjectData,
    previous: ObjectData,
  ) => ObjectData;
  validate?: (
    changed: ObjectData,
    all: ObjectData,
    previous: ObjectData,
  ) => void;
  verify?: (data: ObjectData, changed: ObjectData) => boolean;
  interrupt?:
    | string
    | ((changed: ObjectData, previous: ObjectData) => string | undefined);
  timeout?: number;
};
export const options = (
  key: string,
  label: string,
  values: Option[] | NonNullable<FormField["optionsFor"]>,
  extra: Partial<FormField> = {},
): FormField => ({
  key,
  label,
  ...(typeof values === "function"
    ? { optionsFor: values }
    : { options: values }),
  ...extra,
});
export const flag = (
  key: string,
  label: string,
  wire?: "number" | "boolean",
): FormField =>
  options(
    key,
    label,
    wire === "boolean"
      ? [
          ["false", "Disabled"],
          ["true", "Enabled"],
        ]
      : [
          ["0", "Disabled"],
          ["1", "Enabled"],
        ],
    { wire },
  );
export const field = (
  key: string,
  label: string,
  extra: Partial<FormField> = {},
): FormField => ({ key, label, ...extra });
const string = (value: unknown) =>
  value === undefined || value === null ? "" : String(value);
const same = (a: unknown, b: unknown) => string(a) === string(b);

function waitAbortable(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function submitAsyncApply(options: {
  write: string;
  fallbackWrite?: string;
  statusPath: string;
  method?: string;
  body: unknown;
  timeout?: number;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}) {
  const method = options.method || "PUT";
  let reply: ObjectData;
  try {
    reply = await api(options.write, {
      method,
      body: options.body,
      timeout: 15000,
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && options.fallbackWrite) {
      await api(options.fallbackWrite, {
        method,
        body: options.body,
        timeout: options.timeout || 90000,
        signal: options.signal,
      });
      return;
    }
    throw e;
  }
  if (reply?.verified === true) return;
  const jobId = reply?.job_id;
  options.onStatus?.("Applying and waiting for router…");
  const deadline = Date.now() + Math.max(options.timeout || 70000, 15000);
  let first = true;
  while (Date.now() < deadline) {
    await waitAbortable(first ? 350 : 1200, options.signal);
    first = false;
    try {
      const status = await api(options.statusPath, {
        timeout: 4000,
        signal: options.signal,
      });
      if (jobId !== undefined && status?.job_id && status.job_id !== jobId) {
        if (status.state === "verified" || status.state === "idle") return;
      }
      if (status?.state === "verified") return;
      if (status?.state === "failed") {
        throw new Error(
          status.error || "The router has not confirmed the change.",
        );
      }
      if (status?.state === "idle" && !status?.job_id) return;
      options.onStatus?.("Applying and waiting for router…");
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      if (e instanceof ApiError && e.status === 0) {
        options.onStatus?.("Reconnecting to router…");
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    "The change could not be verified. Check the current state before trying again.",
  );
}

export function SettingsForm({
  spec,
  onApplied,
}: {
  spec: FormSpec;
  onApplied?: () => void;
}) {
  const resource = useResource(spec.read, {
    method: spec.readMethod,
    body: spec.readBody,
  });
  const { epoch } = useSession();
  const mutation = useMutation();
  const scope = spec.scope || "global";
  const scopeBusy = mutation.isBusy(scope);
  const [base, setBase] = useState<ObjectData>(),
    [draft, setDraft] = useState<ObjectData>({}),
    [error, setError] = useState<Error>(),
    [message, setMessage] = useState(""),
    [applying, setApplying] = useState(false);
  const dirty = useRef(new Set<string>()),
    active = useRef(true),
    abortRef = useRef<AbortController | null>(null),
    lastAttempt = useRef<{ f: FormField; value: string } | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      abortRef.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!resource.data) return;
    try {
      const decoded = spec.decode ? spec.decode(resource.data) : resource.data;
      setBase(decoded);
      setDraft((old) =>
        Object.fromEntries(
          spec.fields.map((f) => [
            f.key,
            dirty.current.has(f.key)
              ? old[f.key]
              : f.type === "password"
                ? ""
                : string(decoded[f.readKey || f.key]),
          ]),
        ),
      );
    } catch (e) {
      setError(e as Error);
      setBase(undefined);
    }
  }, [resource.data]);
  const apply = async (f: FormField, value: string) => {
    if (!base || mutation.isBusy(scope)) return;
    const original = base[f.readKey || f.key];
    if ((f.type === "password" && !value) || same(value, original)) {
      dirty.current.delete(f.key);
      setError(undefined);
      setMessage("");
      return;
    }
    const previous = {
      ...base,
      ...Object.fromEntries(
        spec.fields.map((item) => [item.key, base[item.readKey || item.key]]),
      ),
    };
    const nextValue =
      f.wire === "number"
        ? Number(value)
        : f.wire === "boolean"
          ? value === "true"
          : value;
    const changed = { [f.key]: nextValue },
      all = { ...previous, ...changed };
    try {
      if (f.required && !value.trim())
        throw new Error("This field is required");
      if (
        f.type === "number" &&
        (!/^-?\d+$/.test(value) ||
          (f.min !== undefined && Number(value) < f.min) ||
          (f.max !== undefined && Number(value) > f.max))
      )
        throw new Error(
          t("Enter a number between {0} and {1}", f.min ?? 0, f.max ?? 65535),
        );
      const choices = f.optionsFor?.(base) || f.options;
      if (choices && !choices.some(([id]) => id === value))
        throw new Error("Choose a supported value");
      spec.validate?.(changed, all, previous);
      const interrupt =
        typeof spec.interrupt === "function"
          ? spec.interrupt(changed, previous)
          : spec.interrupt;
      if (interrupt && !(await mutation.confirm({ message: interrupt }))) {
        dirty.current.delete(f.key);
        setError(undefined);
        setMessage("");
        setDraft((s) => ({
          ...s,
          [f.key]: f.type === "password" ? "" : string(original),
        }));
        return;
      }
      if (!active.current) return;
      await mutation.run(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        setApplying(true);
        setError(undefined);
        setMessage("Applying…");
        try {
          const before = await api(spec.read, {
            method: spec.readMethod,
            body: spec.readBody,
            signal: controller.signal,
          });
          if (!active.current) return;
          const current = spec.decode ? spec.decode(before) : before;
          if (
            spec.fields.some(
              (item) =>
                item.type !== "password" &&
                !same(
                  current[item.readKey || item.key],
                  base[item.readKey || item.key],
                ),
            )
          ) {
            setBase(current);
            throw new Error(
              "Settings changed elsewhere. Review the current values before trying again.",
            );
          }
          const payload = spec.body ? spec.body(changed, all, previous) : changed;
          if (spec.asyncWrite && spec.asyncStatus) {
            await submitAsyncApply({
              write: spec.asyncWrite,
              fallbackWrite: spec.write || spec.read,
              statusPath: spec.asyncStatus,
              method: spec.method || "PUT",
              body: payload,
              timeout: spec.timeout || 70000,
              signal: controller.signal,
              onStatus: (next) => {
                if (active.current) setMessage(next);
              },
            });
          } else {
            await api(spec.write || spec.read, {
              method: spec.method || "PUT",
              body: payload,
              timeout: spec.timeout || 30000,
              signal: controller.signal,
            });
          }
          if (!active.current) return;
          let decoded: ObjectData = {},
            verified = false,
            lastReadError: unknown;
          const maxAttempts = spec.asyncWrite ? 5 : 3;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (attempt) await waitAbortable(900, controller.signal);
            if (!active.current) return;
            try {
              const fresh = await api(spec.read, {
                method: spec.readMethod,
                body: spec.readBody,
                timeout: spec.asyncWrite ? 8000 : 20000,
                signal: controller.signal,
              });
              lastReadError = undefined;
              if (!active.current) return;
              decoded = spec.decode ? spec.decode(fresh) : fresh;
              verified = spec.verify
                ? spec.verify(decoded, changed)
                : Object.entries(changed).every(([k, v]) =>
                    same(
                      decoded[
                        spec.fields.find((item) => item.key === k)?.readKey || k
                      ],
                      v,
                    ),
                  );
              if (verified) break;
            } catch (readErr) {
              if ((readErr as Error)?.name === "AbortError") throw readErr;
              if (
                spec.asyncWrite &&
                readErr instanceof ApiError &&
                readErr.status === 0 &&
                attempt + 1 < maxAttempts
              ) {
                lastReadError = readErr;
                if (active.current) setMessage("Reconnecting to router…");
                continue;
              }
              throw readErr;
            }
          }
          if (lastReadError) throw lastReadError;
          setBase(decoded);
          if (!verified)
            throw new Error("The router has not confirmed the change.");
          lastAttempt.current = null;
          dirty.current.delete(f.key);
          setDraft((old) =>
            Object.fromEntries(
              spec.fields.map((item) => [
                item.key,
                dirty.current.has(item.key)
                  ? old[item.key]
                  : item.type === "password"
                    ? ""
                    : string(decoded[item.readKey || item.key]),
              ]),
            ),
          );
          setMessage("Applied and verified");
          onApplied?.();
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
          if (active.current) setApplying(false);
        }
      }, scope);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        if (active.current) {
          setError(undefined);
          setMessage("Stopped waiting. Read current state to check.");
        }
        return;
      }
      if (active.current) {
        lastAttempt.current = { f, value };
        setError(e as Error);
        setMessage("");
      }
    }
  };
  const edit = (f: FormField, value: string) => {
    dirty.current.add(f.key);
    setDraft((s) => ({ ...s, [f.key]: value }));
    setError(undefined);
    setMessage("Complete input to apply");
  };
  return (
    <Panel className="form-panel" key={epoch}>
      <PanelTitle title={spec.title} note={spec.note} />
      <ErrorState error={resource.error} retry={resource.reload} />
      {!base ? (
        <p className="loading-state">
          {t(resource.loading ? "Loading…" : "Settings unavailable")}
        </p>
      ) : (
        <div className="form-body">
          <div className="form-grid">
            {spec.fields.map((f) => {
              const available =
                f.allowMissing || base[f.readKey || f.key] !== undefined;
              const disabled = scopeBusy || !available;
              const value = string(draft[f.key]);
              const choices = f.optionsFor?.(base) || f.options;
              return (
                <Field
                  key={f.key}
                  label={f.label}
                  hint={!available ? "Not supported by this firmware" : f.hint}
                >
                  {choices ? (
                    <select
                      disabled={disabled}
                      value={value}
                      onChange={(e) => {
                        edit(f, e.target.value);
                        void apply(f, e.target.value);
                      }}
                    >
                      {!choices.some(([v]) => v === value) && (
                        <option value={value}>
                          {value ? scalar(value) : t("Not reported")}
                        </option>
                      )}
                      {choices.map(([v, label]) => (
                        <option key={v} value={v}>
                          {t(label)}
                        </option>
                      ))}
                    </select>
                  ) : f.type === "password" ? (
                    <Password
                      disabled={disabled}
                      value={value}
                      onChange={(v) => edit(f, v)}
                      onComplete={() => void apply(f, value)}
                      placeholder={t("Leave blank to keep current password")}
                    />
                  ) : f.type === "textarea" ? (
                    <textarea
                      rows={4}
                      disabled={disabled}
                      value={value}
                      onChange={(e) => edit(f, e.target.value)}
                      onBlur={() => void apply(f, value)}
                    />
                  ) : (
                    <input
                      disabled={disabled}
                      type={f.type || "text"}
                      value={value}
                      min={f.min}
                      max={f.max}
                      maxLength={f.maxLength}
                      autoComplete="off"
                      onChange={(e) => edit(f, e.target.value)}
                      onBlur={() => void apply(f, value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.currentTarget.blur();
                        }
                      }}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        </div>
      )}
      <AutoFeedback busy={scopeBusy} message={message} error={error} />
      {applying && (
        <div className="form-actions">
          <button
            type="button"
            className="text-link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => abortRef.current?.abort()}
          >
            {t("Stop waiting")}
          </button>
        </div>
      )}
      {error && !scopeBusy && (
        <div className="form-actions">
          {lastAttempt.current && (
            <button
              type="button"
              className="text-link"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const attempt = lastAttempt.current;
                if (attempt) void apply(attempt.f, attempt.value);
              }}
            >
              {t("Retry")}
            </button>
          )}
          <button
            type="button"
            className="text-link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              lastAttempt.current = null;
              dirty.current.clear();
              setError(undefined);
              setMessage("");
              resource.reload();
            }}
          >
            {t("Discard draft and read current values")}
          </button>
        </div>
      )}
    </Panel>
  );
}
export function CommandForm({
  title,
  note,
  fields = [],
  endpoint,
  method = "POST",
  body,
  warning,
  label,
  after,
  danger = false,
  phrase,
  before,
}: {
  title: string;
  note?: string;
  fields?: FormField[];
  endpoint: string;
  method?: string;
  body?: (values: ObjectData) => unknown;
  warning?: string;
  label: string;
  after?: (data: ObjectData) => void;
  danger?: boolean;
  phrase?: string;
  before?: () => Promise<boolean | void>;
}) {
  const [values, setValues] = useState<ObjectData>(() =>
      Object.fromEntries(fields.map((f) => [f.key, f.options?.[0]?.[0] || ""])),
    ),
    [error, setError] = useState<Error>(),
    [result, setResult] = useState("");
  const mutation = useMutation();
  const mounted = useRef(true),
    abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);
  return (
    <Panel>
      <PanelTitle title={title} note={note} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (
              warning &&
              !(await mutation.confirm({
                title,
                message: warning,
                danger,
                phrase,
              }))
            )
              return;
            await mutation.run(async () => {
              const controller = new AbortController();
              abortRef.current = controller;
              setError(undefined);
              try {
                const payload = body ? body(values) : values;
                if (before && (await before()) === false) return;
                if (!mounted.current) return;
                const data = await api(endpoint, {
                  method,
                  body: payload,
                  timeout: 150000,
                  signal: controller.signal,
                });
                if (!mounted.current) return;
                if (data && typeof data === "object" && "result" in data) {
                  const accepted =
                    endpoint === "/api/sms/send"
                      ? [3, "3"]
                      : [0, "0", true, "success", "SUCCESS"];
                  if (!accepted.includes(data.result))
                    throw new Error(
                      t(
                        "The modem returned result {0}; the action is not confirmed",
                        data.result,
                      ),
                    );
                }
                setResult(
                  endpoint === "/api/sms/send"
                    ? "Send request accepted. Delivery is not confirmed."
                    : "Request accepted.",
                );
                after?.(data);
                setValues((s) => ({
                  ...s,
                  ...Object.fromEntries(
                    fields
                      .filter((f) => f.type === "password")
                      .map((f) => [f.key, ""]),
                  ),
                }));
              } finally {
                if (abortRef.current === controller) abortRef.current = null;
              }
            });
          } catch (error) {
            if ((error as Error)?.name === "AbortError") return;
            if (mounted.current) setError(error as Error);
          }
        }}
      >
        <div className="form-grid">
          {fields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {f.options ? (
                <select
                  disabled={mutation.busy}
                  value={string(values[f.key])}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                >
                  {f.options.map(([v, label]) => (
                    <option value={v} key={v}>
                      {t(label)}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea
                  required={f.required}
                  rows={6}
                  value={string(values[f.key])}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                />
              ) : (
                <input
                  type={f.type || "text"}
                  required={f.required}
                  min={f.min}
                  max={f.max}
                  maxLength={f.maxLength}
                  autoComplete="off"
                  disabled={mutation.busy}
                  value={string(values[f.key])}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                />
              )}
            </Field>
          ))}
        </div>
        <ErrorState error={error} />
        {result && (
          <p className="form-result" role="status">
            {t(result)}
          </p>
        )}
        <button
          className={"btn " + (danger ? "danger" : "primary")}
          disabled={mutation.busy}
          type="submit"
        >
          {t(mutation.busy ? "Applying…" : label)}
        </button>
      </form>
    </Panel>
  );
}
export function ReadingsPanel({
  title,
  path,
  rows,
}: {
  title: string;
  path: string;
  rows: [string, string][];
}) {
  const r = useResource(path);
  return (
    <Panel>
      <PanelTitle
        title={title}
        action={<Refresh onClick={r.reload} disabled={r.loading} />}
      />
      <ErrorState error={r.error} />
      <dl className="definition">
        {rows.map(([key, label]) => (
          <div key={key}>
            <dt>{t(label)}</dt>
            <dd>{scalar(r.data?.[key])}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
