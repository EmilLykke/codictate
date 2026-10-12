import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AppSettings,
  CommandLineInstallResult,
  CommandLineInstallState,
} from "../../../../shared/types";
import {
  addCommandLineToPath,
  fetchCommandLineInstall,
  fetchSettings,
  installCommandLine,
  removeCommandLine,
  setCommandLineControl,
} from "../../../rpc";
import { settingsHelperClass } from "../settings-shared";
import { Switch } from "../../Common/Switch";

type Props = {
  settings: AppSettings;
};

const HEADING =
  "text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3";
const CARD = "rounded-xl border border-overlay/11 bg-surface-1 overflow-hidden";
const BUTTON =
  "shrink-0 px-3 py-1.5 rounded-lg text-[14px] font-medium border transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 border-overlay/12 hover:border-overlay/20 bg-surface-1 hover:bg-surface-2 text-overlay/62 hover:text-overlay/82";
const CODE =
  "font-mono text-[13px] text-overlay/72 break-all select-text leading-relaxed";

const INSTALL_QUERY_KEY = ["commandLineInstall"] as const;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={BUTTON}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-overlay/8 bg-surface-2 px-3 py-2">
      <code className={`${CODE} flex-1 min-w-0`}>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

export function SectionCommandLine({ settings }: Props) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { data: install } = useQuery({
    queryKey: INSTALL_QUERY_KEY,
    queryFn: fetchCommandLineInstall,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const handleControlToggle = useCallback(async () => {
    const next = !settings.commandLineControl;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, commandLineControl: next } : old,
    );
    const ok = await setCommandLineControl(next);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [queryClient, settings.commandLineControl]);

  const run = useCallback(
    async (action: () => Promise<CommandLineInstallResult>) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await action();
        queryClient.setQueryData(INSTALL_QUERY_KEY, result.state);
        setMessage(result.ok ? null : result.message);
      } catch {
        setMessage("Something went wrong. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [queryClient],
  );

  const isWindows = settings.capabilities.platform === "windows";
  const examplePath = isWindows
    ? "~\\Downloads\\memo.m4a"
    : "~/Downloads/memo.m4a";

  return (
    <>
      <div className="mb-8">
        <h2 className={HEADING}>Control</h2>
        <div className={CARD}>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div className="flex-1 min-w-0">
              <span
                className={`block text-[17px] font-medium ${settings.commandLineControl ? "text-overlay/78" : "text-overlay/58"}`}
              >
                Command-Line Control
              </span>
              <span className="mt-0.5 block text-[13px] text-overlay/40 leading-snug">
                Lets apps and scripts on this computer start a Dictation and
                change Codictate's settings through the <code>codictate</code>{" "}
                command.
              </span>
            </div>
            <Switch
              checked={settings.commandLineControl}
              onCheckedChange={() => void handleControlToggle()}
              aria-label="Toggle Command-Line Control"
            />
          </div>
        </div>
        <p className={settingsHelperClass}>
          Transcribing files and reading status always work, even with this off.
        </p>
      </div>

      <div className="mb-8">
        <h2 className={HEADING}>
          {install?.platform === "windows" ? "Path" : "Install"}
        </h2>
        {install === undefined ? (
          <div className={`${CARD} px-4 py-3.5 text-[15px] text-overlay/44`}>
            Checking…
          </div>
        ) : (
          <InstallCard
            install={install}
            busy={busy}
            onInstall={(replace) => void run(() => installCommandLine(replace))}
            onRemove={() => void run(removeCommandLine)}
            onAddToPath={() => void run(addCommandLineToPath)}
          />
        )}
        {message !== null && (
          <p className="mt-3 text-[14px] text-accent-amber/80 leading-relaxed">
            {message}
          </p>
        )}
      </div>

      <div className="mb-8">
        <h2 className={HEADING}>Try it</h2>
        <div className={`${CARD} px-4 py-3.5 flex flex-col gap-1`}>
          <code className={CODE}>codictate transcribe {examplePath}</code>
          <code className={CODE}>codictate status</code>
        </div>
        <p className={settingsHelperClass}>
          Run{" "}
          <code className="font-mono text-overlay/62">codictate --help</code> to
          see everything it can do.
        </p>
      </div>
    </>
  );
}

function InstallCard({
  install,
  busy,
  onInstall,
  onRemove,
  onAddToPath,
}: {
  install: CommandLineInstallState;
  busy: boolean;
  onInstall: (replace: boolean) => void;
  onRemove: () => void;
  onAddToPath: () => void;
}) {
  if (install.platform === "linux") {
    return (
      <div className={`${CARD} px-4 py-3.5 text-[15px] text-overlay/58`}>
        The command line isn't available on Linux yet.
      </div>
    );
  }

  if (install.platform === "windows") {
    return (
      <div className={CARD}>
        <div className="flex items-center gap-3 px-4 py-3.5">
          <div className="flex-1 min-w-0">
            <span className="block text-[17px] font-medium text-overlay/78">
              {install.onPath === true
                ? "On your Path"
                : install.onPath === false
                  ? "Not on your Path"
                  : "Couldn't read your Path"}
            </span>
            <span className="mt-0.5 block text-[13px] text-overlay/40 leading-snug">
              {install.onPath === true
                ? "codictate works in any new terminal."
                : "Add the command's folder so codictate works in any terminal. Terminals you open afterwards pick it up."}
            </span>
          </div>
          {install.onPath !== true && (
            <button
              type="button"
              disabled={busy}
              onClick={onAddToPath}
              className={BUTTON}
            >
              Add to PATH
            </button>
          )}
        </div>
        <div className="border-t border-overlay/10 px-4 py-3">
          <code className={CODE}>{install.binDir}</code>
        </div>
      </div>
    );
  }

  const mustMove =
    install.clientPath !== null &&
    install.mustMoveToApplications &&
    install.link !== "installed";

  const status =
    install.clientPath === null
      ? {
          title: "Not available",
          detail: "This copy of Codictate doesn't include the command.",
        }
      : mustMove
        ? {
            title: "Move Codictate first",
            detail:
              "Move Codictate to your Applications folder first, then install the command.",
          }
        : install.link === "installed"
          ? { title: "Installed", detail: install.linkPath }
          : install.link === "other-codictate"
            ? {
                title: "Points to another Codictate",
                detail: `${install.linkPath} runs a different copy of Codictate.`,
              }
            : install.link === "foreign"
              ? {
                  title: "A different file is there",
                  detail: `Something else is already at ${install.linkPath}, so Codictate leaves it alone.`,
                }
              : {
                  title: "Not installed",
                  detail: `Adds ${install.linkPath} so you can run codictate in a terminal.`,
                };

  return (
    <div className={CARD}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="flex-1 min-w-0">
          <span
            className={`block text-[17px] font-medium ${install.link === "installed" ? "text-overlay/78" : "text-overlay/58"}`}
          >
            {status.title}
          </span>
          <span className="mt-0.5 block text-[13px] text-overlay/40 leading-snug break-all">
            {status.detail}
          </span>
        </div>
        {!mustMove &&
          install.clientPath !== null &&
          install.link === "not-installed" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onInstall(false)}
              className={BUTTON}
            >
              Install command
            </button>
          )}
        {!mustMove &&
          install.clientPath !== null &&
          install.link === "other-codictate" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onInstall(true)}
              className={BUTTON}
            >
              Replace
            </button>
          )}
        {install.link === "installed" && (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className={BUTTON}
          >
            Remove
          </button>
        )}
      </div>

      {install.link === "installed" && install.onPath !== true && (
        <div className="border-t border-overlay/10 px-4 py-3 flex flex-col gap-2">
          <span className="text-[13px] text-overlay/52 leading-snug">
            {install.onPath === false
              ? `One more step: ~/.local/bin isn't on your PATH yet. ${install.pathSetup.where}, then open a new terminal.`
              : `Couldn't check your PATH. If codictate isn't found, ${install.pathSetup.where.charAt(0).toLowerCase()}${install.pathSetup.where.slice(1)}.`}
          </span>
          <CodeLine text={install.pathSetup.line} />
        </div>
      )}
    </div>
  );
}
