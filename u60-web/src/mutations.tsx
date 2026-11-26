import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "./live";
import { Modal } from "./ui";
import { t } from "./i18n";
type Confirmation = {
  message: string;
  title?: string;
  danger?: boolean;
  phrase?: string;
};
const Context = createContext<{
  busy: boolean;
  isBusy: (scope?: string) => boolean;
  confirm: (options: Confirmation) => Promise<boolean>;
  run: <T>(work: () => Promise<T>, scope?: string) => Promise<T>;
}>({
  busy: false,
  isBusy: () => false,
  confirm: async () => false,
  run: async (work) => work(),
});
export function MutationProvider({ children }: { children: ReactNode }) {
  const { epoch } = useSession();
  const [busyScopes, setBusyScopes] = useState<string[]>([]),
    [pending, setPending] = useState<Confirmation | null>(null),
    [phrase, setPhrase] = useState("");
  const resolve = useRef<((value: boolean) => void) | undefined>(undefined),
    inFlight = useRef(new Set<string>());
  const finish = (yes: boolean) => {
    resolve.current?.(yes);
    resolve.current = undefined;
    setPending(null);
    setPhrase("");
  };
  useEffect(
    () => () => {
      resolve.current?.(false);
    },
    [epoch],
  );
  useEffect(() => {
    const cancel = () => finish(false);
    window.addEventListener("hashchange", cancel);
    return () => window.removeEventListener("hashchange", cancel);
  }, []);
  const isBusy = (scope = "global") => busyScopes.includes(scope);
  return (
    <Context.Provider
      value={{
        busy: isBusy("global"),
        isBusy,
        confirm: (options) => {
          finish(false);
          setPending(options);
          return new Promise((yes) => {
            resolve.current = yes;
          });
        },
        run: async (work, scope = "global") => {
          if (inFlight.current.has(scope))
            throw new Error("Wait for the current operation");
          inFlight.current.add(scope);
          setBusyScopes([...inFlight.current]);
          try {
            return await work();
          } finally {
            inFlight.current.delete(scope);
            setBusyScopes([...inFlight.current]);
          }
        },
      }}
    >
      {children}
      {pending && (
        <Modal
          title={pending.title || "This change interrupts connections"}
          close={() => finish(false)}
        >
          <p>{t(pending.message)}</p>
          {pending.phrase && (
            <label className="field">
              <span>{t("Type {0} to confirm", pending.phrase)}</span>
              <input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          <div className="dialog-actions">
            <button className="btn" onClick={() => finish(false)}>
              {t("Cancel change")}
            </button>
            <button
              className={"btn " + (pending.danger ? "danger" : "primary")}
              disabled={!!pending.phrase && phrase !== pending.phrase}
              onClick={() => finish(true)}
            >
              {t("Continue and apply")}
            </button>
          </div>
        </Modal>
      )}
    </Context.Provider>
  );
}
export const useMutation = () => useContext(Context);
