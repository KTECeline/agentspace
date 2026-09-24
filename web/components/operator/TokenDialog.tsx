"use client";

import { useEffect, useId, useRef, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useOffice } from "@/lib/store";

/** Header button + dialog for the operator token (stored in this browser only). */
export function TokenButton({ onSaved }: { onSaved: () => void }) {
  const token = useOffice((s) => s.token);
  const open = useOffice((s) => s.openTokenDialog);
  return (
    <>
      <button
        type="button"
        onClick={() => open(true)}
        aria-label={token ? "Operator token (set)" : "Add operator token"}
        title={token ? "Operator token is set" : "Add operator token"}
        className="relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <KeyRound aria-hidden className="size-4" />
        {token && <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-[var(--st-done-dot)]" />}
      </button>
      <TokenDialog onSaved={onSaved} />
    </>
  );
}

function TokenDialog({ onSaved }: { onSaved: () => void }) {
  const isOpen = useOffice((s) => s.tokenDialogOpen);
  const open = useOffice((s) => s.openTokenDialog);
  const token = useOffice((s) => s.token);
  const setToken = useOffice((s) => s.setToken);
  const collector = useOffice((s) => s.collector);
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  const inputId = useId();
  const hintId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (isOpen && !d.open) {
      setValue("");
      d.showModal();
    } else if (!isOpen && d.open) d.close();
  }, [isOpen]);

  const save = (t: string | null) => {
    setToken(t);
    open(false);
    onSaved();
  };

  return (
    <dialog
      ref={ref}
      onClose={() => open(false)}
      aria-labelledby={`${inputId}-title`}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/40"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) save(value.trim());
        }}
        className="flex flex-col gap-4 p-5"
      >
        <div className="flex items-start gap-3">
          <h2 id={`${inputId}-title`} className="mr-auto font-display text-lg font-semibold">
            Operator token
          </h2>
          <button
            type="button"
            onClick={() => open(false)}
            aria-label="Close"
            className="-mr-2 -mt-1 inline-flex size-9 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            Token
          </label>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={hintId}
            placeholder={token ? "Enter a new token to replace the saved one" : "AGENTSPACE_OPERATOR_TOKEN or an API key"}
            className="h-10 rounded-md border border-border bg-background px-3 font-mono text-sm placeholder:font-sans placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p id={hintId} className="text-sm text-muted">
            Lets you watch a protected office and approve, pause or cancel runs. Saved in this browser and sent only to{" "}
            <span className="font-mono text-foreground">{collector?.url ?? "the collector"}</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!value.trim()}
            className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save token
          </button>
          {token && (
            <button
              type="button"
              onClick={() => save(null)}
              className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Forget saved token
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
